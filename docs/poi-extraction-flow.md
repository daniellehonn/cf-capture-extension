# POI Extraction Flow

> How a user input (YouTube / TikTok / Instagram / article query / image) becomes structured POI data — covering SOP selection, mode routing, caching, LLM execution, and streaming geocoding.

---

## End-to-End Flow

```
User pastes URL / query / image
  │
  ▼
[Web Proxy]  apps/web/app/api/context-map/extract/route.ts
  │  1. Detect input type (YouTube / TikTok / Instagram / entity query / image)
  │  2. Select SOP + effective mode (see §1)
  │  3. Cache check against R2_BUCKET (see §2) — return early on hit
  │  4. Call agent-hub POST /api/execute-sop
  │  5. Instant mode: parse agent-hub's text stream, geocode POIs in parallel,
  │     stream back as NDJSON
  │     Non-instant: forward JSON response; cache write
  │
  ▼
[Agent Hub]  src/app/api/execute-sop/route.ts
  │  Branch on input:
  │    - image       → multimodal Gemini
  │    - YouTube     → transcript → LLM (fast/instant), OR video URL → Gemini (deep)
  │    - TikTok      → mcp-hub download → base64 → Gemini
  │    - Instagram   → mcp-hub download → R2 → base64 → Gemini
  │    - entity      → mcp-hub web-search + page extract → LLM
  │  Enrich result with _videoMeta / _processMeta / sources
  │
  ▼
[Web Proxy → Client]
  │  Instant: NDJSON stream (videoMeta, meta, poi, trace rows)
  │  Other:   JSON { pois, tips, sources, _videoMeta, _processMeta }
  │
  ▼
[map.js]  Renders POI cards, map, "View Map" → saves capture
```

The **web app owns all cache reads and writes** under `experiences/` in `R2_BUCKET` (`fortypirates-apps`). Agent-hub is extraction-only and no longer touches `experiences/`.

---

## 1. SOP Selection (Web Proxy)

[apps/web/app/api/context-map/extract/route.ts:200-234](../../../../apps/web/app/api/context-map/extract/route.ts#L200-L234) picks the SOP from the input type, then overrides `effectiveMode` when needed:

| Input | SOP ID | Effective Mode | LLM Input |
|-------|--------|----------------|-----------|
| Entity query (`/anime X`, `/movie X`, `/celeb X`, `/food X`, …) | `entity-poi-extraction` | `fast` | Web-search markdown → text LLM |
| Image upload | `image-spatial-intelligence` | `deep` | Image → Gemini vision |
| YouTube + `instant` | `video-instant-poi-extraction` | `instant` | Transcript (fallback: video URL) → Gemini |
| YouTube + `fast` | `video-instant-poi-extraction` ⚠️ | forced to `instant` | same as above |
| YouTube + `deep` | `video-deep-poi-extraction` | `deep` | Video URL → Gemini |
| TikTok (any mode) | same SOP as chosen mode | passes through | Downloaded video → Gemini |
| Instagram Reel (any mode) | same SOP as chosen mode | passes through | Downloaded video → Gemini |

> **Note:** `fast` and `instant` now route to the same SOP. The web proxy forces `effectiveMode = 'instant'` whenever it selects `video-instant-poi-extraction`, so the legacy `video-poi-extraction` SOP (transcript → full JSON) is no longer reached through this route. The agent-hub still has a fast-mode branch for callers that invoke `execute-sop` directly with `extractionMode: 'fast'`.

TikTok / Instagram detection happens inline: the proxy still forwards to agent-hub with the chosen SOP; agent-hub branches on the URL host.

### Instant mode output format

The `video-instant-poi-extraction` SOP streams a tag-based text format so the web proxy can fire off place-search calls while the LLM is still generating:

```
[video-meta]{"title":"...","author":"...","thumbnailUrl":"..."}[/video-meta]
[primary-location]Tokyo, Japan|35.6762|139.6503[/primary-location]
[airport]NRT[/airport]
Tongin Market
Bukchon Hanok Village
Gwangjang Market
Starbucks Reserve @ Osaka, Japan
[performance]{"totalMs":1234,...}[/performance]
```

- One POI per line. Outliers use `Name @ City, Country`.
- `[primary-location]` carries optional `|lat|lng` so the web proxy biases place-search to the right region.
- `[video-meta]` / `[performance]` are emitted by agent-hub around the LLM stream.

### Transcript-error fallback

If the first call fails with a transcript-related error, the proxy automatically retries in **deep mode** using `video-deep-poi-extraction` and tags the response with `X-Extraction-Mode: deep` so the client can re-parse ([extract/route.ts:311-356](../../../../apps/web/app/api/context-map/extract/route.ts#L311-L356)).

---

## 2. Cache Layer (Web Proxy)

The cache lives in the **web app's** `R2_BUCKET` (`fortypirates-apps`) under `experiences/`. Utilities in [apps/web/lib/experience-cache.ts](../../../../apps/web/lib/experience-cache.ts).

**Cache key format:**

| Type | Key |
|------|-----|
| YouTube | `experiences/youtube_{videoId}_{mode}.json` where mode ∈ `f`/`d`/`i` |
| Instagram | `experiences/instagram_{shortcode}_{mode}.json` |
| TikTok | `experiences/tiktok_{videoId}_{mode}.json` |
| Entity | `experiences/entity_{type}_{compactName}.json` |
| Curated entity | `experiences/entity_{type}_{name}_curated.json` |

- **No SOP hash** anymore — invalidation is manual (via `/api/experiences` admin UI or by overwriting the key).
- **Local dev fallback:** `.next/cache/experiences/{filename}.json` when `NODE_ENV === 'development'` and R2 is not bound.
- [`rekeyLegacy`](../../../../apps/web/lib/experience-cache.ts#L152) migrates old `_cache/…` and hashed filenames to the new shape.

**Lookup order:** R2 (`R2_BUCKET.get`) → local FS (dev only) → miss.

**Cache hit behavior** ([extract/route.ts:256-283](../../../../apps/web/app/api/context-map/extract/route.ts#L256-L283)):

- Regular hit → return `{ ...cached, _videoMeta: resolvedUrls, _cached: true }` as JSON.
- **Instant-mode hit with `_instant: true`**: re-geocode the cached POI names via `createGeocodingStream` and stream NDJSON back to the client, reusing any stored `primaryLocationCoords` for biasing. This lets stale caches still serve fresh place-search results without another LLM call.

**Cache write:**

- Non-instant paths: `writeCache(cacheKey, data, env)` after the agent-hub response is parsed.
- Instant path: fire-and-forget write inside the NDJSON stream after all POIs have been emitted ([extract/route.ts:536-547](../../../../apps/web/app/api/context-map/extract/route.ts#L536-L547)). The cached object stores POI *names* + `primaryLocation` + `_videoMeta` + `_rawText`, flagged with `_instant: true`.

---

## 3. Agent-Hub Execution Branches

[apps/agentic/agent-hub/src/app/api/execute-sop/route.ts](../../../../apps/agentic/agent-hub/src/app/api/execute-sop/route.ts) switches on the input shape. Agent-hub no longer performs any `experiences/` caching — the web app is the sole owner.

### 3.1 YouTube — Fast / Instant (transcript path)

[route.ts:157-406](../../../../apps/agentic/agent-hub/src/app/api/execute-sop/route.ts#L157-L406)

1. **Obtain transcript**
   - If `inputs.textContext` was passed, use it directly.
   - Otherwise GET `mcp-hub/api/youtube/transcript?url=...`. The response may also return `videoDetails` which is captured as `transcriptVideoMeta` so we don't need a second `/api/youtube/detail` call.
   - Segments are formatted as `[m:ss] text`. Offsets > 36000 are treated as milliseconds, otherwise seconds.
2. **Instant mode** (`extractionMode === 'instant'`):
   - Re-assembles context with `params.transcript`.
   - If the transcript succeeded → calls AI SDK `streamText(getModel(modelId))` against the assembled system prompt and pipes each chunk out to the client as `text/plain`, with a leading `[video-meta]…[/video-meta]` line when metadata is available.
   - If no transcript (video-only fallback) → calls `execJSON` with `media: { type: 'video', data: videoUrl }` and `responseMimeType: 'text/plain'`. Gemini returns the same tagged text format directly; agent-hub parses primary-location / airport / POI lines for its cache-shaped return.
3. **Fast mode** (`extractionMode === 'fast'`, only reachable by direct callers since the web proxy forces instant):
   - Calls `execJSON` with `prompt: "## VIDEO TRANSCRIPT\n\n{formatted}\n\n---\nAnalyze…"` and the SOP schema. Returns JSON.
4. **No transcript + not instant** → returns HTTP 400 with `"Failed to fetch transcript. Video may not have captions. Try deep mode."` — the web proxy uses this to trigger its deep-mode fallback.

### 3.2 YouTube — Deep

[route.ts:408-457](../../../../apps/agentic/agent-hub/src/app/api/execute-sop/route.ts#L408-L457). Pure multimodal call:

```ts
execJSON({
  context: context.systemPrompt,
  prompt: "CRITICAL REQUIREMENTS: ... visual+audio, every segment, visualTags ...",
  media: { type: 'video', data: inputs.videoUrl },
  model: context.models,
  schema: sop.resolvedSchema || sop.outputSchema,
  schemaMode: sop.schemaMode,
})
```

Gemini downloads and analyses the video itself via `file_data.file_uri` (§4).

### 3.3 TikTok

[route.ts:459-552](../../../../apps/agentic/agent-hub/src/app/api/execute-sop/route.ts#L459-L552). TikTok videos can't be streamed by URL, so they're downloaded first:

1. `GET mcp-hub/api/tiktok/video-detail` → CDN URL + description.
2. `GET mcp-hub/api/tiktok/proxy-video` → raw video bytes.
3. `Buffer.from(bytes).toString('base64')` → `data:video/mp4;base64,{…}`.
4. `execJSON` with `media: { type: 'video', data: base64, mimeType: 'video/mp4' }` → Gemini `inline_data`.
5. A `_performance` object (`downloadTime`, `uploadTime`, `processTime`, `totalTime`) is attached to the result.

### 3.4 Instagram Reels

[route.ts:554-750](../../../../apps/agentic/agent-hub/src/app/api/execute-sop/route.ts#L554-L750). Similar to TikTok but goes through mcp-hub's R2 pipeline:

1. `GET mcp-hub/api/instagram/post` → post metadata (video URL, caption, thumbnail key). mcp-hub has already cached the thumbnail to R2 and returned the R2 key.
2. `GET mcp-hub/api/instagram/download` → downloads the video via residential proxy and persists it to the `CRAWL_DATA` R2 bucket, returning `{ r2Key, cached }`.
3. Fetch the bytes from R2 directly (`env.CRAWL_DATA.get(r2Key)`) or, in dev, via `mcp-hub/r2/{key}`.
4. Base64-encode → `execJSON` as `inline_data` with the chosen model.
5. **Instant mode** → `responseMimeType: 'text/plain'`, emits `[video-meta]` + `[performance]` + the tagged POI stream.
6. **Deep / fast** → normal JSON via schema, with `_performance` and a synthesized `_videoMeta` attached.

### 3.5 Entity Query

[route.ts:752-965](../../../../apps/agentic/agent-hub/src/app/api/execute-sop/route.ts#L752-L965).

1. `detectEntityType(query)` parses `/anime`, `/movie`, `/celeb`, `/food`, `/place` prefixes (or falls back to keyword heuristics).
2. `buildEntitySearchQuery` produces a compact search like `"Your Name" places to visit`.
3. `GET mcp-hub/api/web-search?query=…&topN=5&showImage=true` → search + crawl results. Images are harvested from `imageUrl` / `image` / `thumbnail` fields.
4. If `inputs.url` is also provided, `GET mcp-hub/api/page/extract?url=…` is merged in as the "Primary Article".
5. A POI-count hint is derived from `\d+\.\s` patterns and list titles (`"top 15 locations"`) and injected as a completeness check.
6. `execJSON` runs with a type-specific prompt (`buildEntityContextPrompt`) wrapped around the combined markdown and returns JSON.
7. `sourceId` references in POIs/tips are preserved as-is; the `sources` array is enriched with images from the search crawl (fallback: use crawl results directly) and is prepended with a `Primary Article` entry if `inputs.url` was supplied.
8. `_videoMeta` is synthesized from `coverImage` or the first POI image so the frontend header can render a cover.

### 3.6 Image

[route.ts:141-156](../../../../apps/agentic/agent-hub/src/app/api/execute-sop/route.ts#L141-L156). The base64 image is passed to `execJSON` as `media: { type: 'image', data }`; Gemini's vision handles it directly.

---

## 4. LLM Execution Engine (`src/llm/core.ts`)

### Model selection & fallback

`executeJSON()` accepts a model sequence (e.g. `["gemini-2.5-flash", "gpt-4o-mini"]`) and tries each in order ([llm/core.ts:410-435](../../../../apps/agentic/agent-hub/src/llm/core.ts#L410-L435)).

### Routing decision

[llm/core.ts:440-490](../../../../apps/agentic/agent-hub/src/llm/core.ts#L440-L490):

```
Is the current model a gemini-* AND GOOGLE_GENERATIVE_AI_API_KEY is set?
  YES → executeGeminiDirect()       ← used for ALL Gemini calls, not just media
  NO  → AI SDK generateObject()     ← OpenAI, fallback
```

Direct Gemini is now preferred for *every* Gemini call (text, image, video, and entity extraction) because the raw REST API gives us higher `maxOutputTokens` (65536), proper schema handling via `responseSchema`, and explicit support for `file_data.file_uri` (which the AI SDK can't map for YouTube URLs).

### LLM Router opt-in

Setting `USE_LLM_ROUTER=true` in agent-hub swaps `executeJSON` for `executeJSONViaRouter`, which proxies structured-output requests through `mcp-hub`'s `/api/llm/generate` endpoint ([execute-sop/route.ts:100-103](../../../../apps/agentic/agent-hub/src/app/api/execute-sop/route.ts#L100-L103)). Default is `false` — agent-hub calls providers directly.

### Gemini direct request shape

```json
{
  "systemInstruction": { "parts": [{ "text": "<persona + SOP + date + schema (inline mode)>" }] },
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "Analyze the video ..." },
      { "file_data": { "mime_type": "video/mp4", "file_uri": "https://youtube.com/..." } }
    ]
  }],
  "generationConfig": {
    "temperature": 0,
    "responseMimeType": "application/json",
    "maxOutputTokens": 65536,
    "responseSchema": { /* only when schemaMode !== 'inline' */ }
  }
}
```

Media parts follow three shapes ([llm/core.ts:530-584](../../../../apps/agentic/agent-hub/src/llm/core.ts#L530-L584)):

- **YouTube URL** → `file_data.file_uri`
- **Base64 video** (TikTok, Instagram, image-as-video) → `inline_data`
- **Base64 image** → `inline_data`, placed **first** in the parts array for better vision attention

**Special cases:**

- `request.responseMimeType === 'text/plain'` → Gemini's text is returned verbatim (no `JSON.parse`). Used by the instant-mode video fallback path.
- Gemini 3 models get `thinkingConfig: { thinkingBudget: 1024 }` automatically.

### Schema modes

SOPs declare how their schema is applied via `output_schema.mode`:

| Mode | How it works | When to use |
|------|-------------|-------------|
| `responseSchema` (default) | Passed to Gemini's `generationConfig.responseSchema` | Strict structure enforcement |
| `inline` | Schema text appended to the system prompt as `## OUTPUT SCHEMA` | Custom / loose schemas, or non-Gemini models |

Both modes rely on `JSON.parse` of the final response — there's no zod/ajv validation step.

---

## 5. Context Assembly

[src/agentic/context/context-assembler.ts](../../../../apps/agentic/agent-hub/src/agentic/context/context-assembler.ts) builds the system prompt:

```
System prompt = [A] Agent persona (travel-scout.md)
              + [B] SOP procedure frame (Objective + Execution Steps)
              + [C] Date context ("Today is Saturday, March 7, 2026")
              + [D] Schema (only in `inline` mode — appended by llm/core.ts)
```

In `mode: 'extraction'` the UI macros and "TOOL FIRST" directives from the agent persona are skipped — those only apply to interactive chat.

SOP frontmatter examples:

```yaml
# Instant — streaming text, no output_schema (format is defined inline in the SOP body)
id: "video-instant-poi-extraction"
models: ["gemini-2.0-flash-lite"]

# Deep — full JSON with visualTags
id: "video-deep-poi-extraction"
models: ["gemini-2.5-flash"]
output_schema:
  file: "schemas/video-deep-poi-extraction-inline.txt"
  mode: "inline"
```

Schemas are loaded by `sop-registry.ts`: JSON files are `JSON.parse`-d, `.txt` files are kept as raw text. The result is stored as `sop.resolvedSchema` + `sop.schemaMode` and passed into `executeJSON`.

---

## 6. Post-LLM Enrichment (Agent Hub)

After the LLM call, `execute-sop/route.ts` attaches metadata before responding ([route.ts:981-1063](../../../../apps/agentic/agent-hub/src/app/api/execute-sop/route.ts#L981-L1063)):

- **`_videoMeta`** — uses `preSuppliedVideoMeta` from the web proxy if available; otherwise `GET mcp-hub/api/youtube/detail?url=…`. TikTok/Instagram branches build their own from the post/channel data. Entity mode synthesizes one from `coverImage` / first POI image.
- **`_processMeta`** — `{ sopId, agentId, mode, transcriptPreFetched }`. The web proxy later adds `userGeo` from Cloudflare request headers.
- **`sources`** — `[{ url, title, type, image, addedAt }]`. Video types are `youtube` / `tiktok` / `video`. Entity mode keeps the LLM's sources and enriches them with images from the search crawl.
- **`_v: 1`** — schema version marker.

---

## 7. Frontend Geocoding & Streaming

Geocoding is now done **inside the web proxy** for streaming modes (instant cache-hit and instant fresh), and inside `map.js` for non-streaming modes.

### 7.1 NDJSON streaming (instant mode)

[extract/route.ts:73-170 & 366-554](../../../../apps/web/app/api/context-map/extract/route.ts#L73-L170) — two code paths share the same output shape:

- `createGeocodingStream(...)` — used on cache hits. Takes the cached POI names and geocodes them in parallel.
- The fresh-extraction path wraps `agent-hub`'s text stream: it parses `[video-meta]` / `[primary-location]` / `[airport]` / `[performance]` tags and fires a `place-search` call for every non-tag line as soon as it arrives (`geocodePoi` runs fire-and-forget).

Both paths emit one NDJSON object per line:

```
{"type":"videoMeta","data":{...}}
{"type":"meta","primaryLocation":"Tokyo, Japan"}
{"type":"meta","airportCode":"NRT"}
{"type":"poi","data":{"id":"poi-0","name":"Tongin Market","status":"success","coordinates":{...}, ...}}
{"type":"poi","data":{"id":"poi-1","name":"...","status":"not-found"}}
{"type":"trace","data":{"totalMs":2134,"agentHubMs":1200,"geocodeMs":900,"poiFound":12,...}}
```

Place-search is biased with `lat`/`lng` either from the `[primary-location]` tag (when the LLM supplied coords) or from `resolveLocationBias(primaryLocation)` (another `place-search` call just for the city).

### 7.2 Non-streaming path (deep / entity)

The JSON response is handed straight to the client. `apps/web/public/home-design/map.js` then geocodes each POI via `GET mcp-hub/api/place-search?name=…&allowMapResultImage=true`, writes back `coordinates`, `address`, `rating`, `imageUrl`, `placeId`, `status`, and renders the POI cards.

### 7.3 Capture save

"View Map" in `map.js` triggers `POST /api/captures`:

1. Auth via Better Auth → `ensurePirateForUser()`.
2. Dedup on `owner_id + source_url` → return existing if found.
3. Insert into `captures.data_jsonb` with `{ pois, tips, videoMeta, userGeo, sources }`.
4. Guest users: data is held in `sessionStorage` as `pendingCapture` and committed after signup.

---

## 8. Error Handling

| Failure | Behavior |
|---------|----------|
| YouTube transcript fetch fails (instant/fast) | Agent-hub returns HTTP 400 with "try deep mode" — web proxy retries in deep mode automatically |
| YouTube transcript fails but mode is instant | Falls through to video-URL Gemini call with `responseMimeType: 'text/plain'` |
| SOP not found | `404` from agent-hub |
| SOP missing `outputSchema` (non-instant) | `400` from agent-hub |
| TikTok / Instagram post unavailable | `400` with `details` message |
| All LLM models in sequence fail | Throws `"All models in sequence failed: ..."` |
| POI geocoding fails | POI marked `status: 'not-found' \| 'error'`, still streamed to client, skipped on map |
| Web search returns nothing (entity mode) | `400 "No content found"` |

---

## 9. Key Source Files

| File | Role |
|------|------|
| [apps/web/app/api/context-map/extract/route.ts](../../../../apps/web/app/api/context-map/extract/route.ts) | Web proxy — SOP selection, cache, NDJSON geocoding, fallback |
| [apps/web/lib/experience-cache.ts](../../../../apps/web/lib/experience-cache.ts) | Cache key builders, R2/local read/write, legacy re-keyer |
| [apps/web/public/home-design/map.js](../../../../apps/web/public/home-design/map.js) | Frontend — non-stream geocoding, POI cards, capture save |
| [apps/agentic/agent-hub/src/app/api/execute-sop/route.ts](../../../../apps/agentic/agent-hub/src/app/api/execute-sop/route.ts) | Main orchestrator — transcript, multimodal branches, enrichment |
| [apps/agentic/agent-hub/src/llm/core.ts](../../../../apps/agentic/agent-hub/src/llm/core.ts) | LLM engine — model fallback, Gemini direct, schema modes, router opt-in |
| [apps/agentic/agent-hub/src/agentic/context/context-assembler.ts](../../../../apps/agentic/agent-hub/src/agentic/context/context-assembler.ts) | Prompt assembly — persona + SOP + date |
| [apps/agentic/agent-hub/src/agentic/sop/sop-registry.ts](../../../../apps/agentic/agent-hub/src/agentic/sop/sop-registry.ts) | SOP loading, schema resolution from file/inline |
| [apps/agentic/agent-hub/config/agents/travel-scout.md](../../../../apps/agentic/agent-hub/config/agents/travel-scout.md) | Agent persona + default model/tool config |
| [apps/agentic/agent-hub/config/recipes/video-instant-poi-extraction.md](../../../../apps/agentic/agent-hub/config/recipes/video-instant-poi-extraction.md) | Instant mode SOP (names only, streamable text) |
| [apps/agentic/agent-hub/config/recipes/video-deep-poi-extraction.md](../../../../apps/agentic/agent-hub/config/recipes/video-deep-poi-extraction.md) | Deep mode SOP (multimodal → full details + visualTags) |
| [apps/agentic/agent-hub/config/recipes/entity-poi-extraction.md](../../../../apps/agentic/agent-hub/config/recipes/entity-poi-extraction.md) | Entity query SOP (web-search → crawl → JSON) |
| [apps/agentic/agent-hub/config/recipes/image-spatial-intelligence.md](../../../../apps/agentic/agent-hub/config/recipes/image-spatial-intelligence.md) | Image SOP |
| [apps/agentic/agent-hub/config/schemas/video-deep-poi-extraction-inline.txt](../../../../apps/agentic/agent-hub/config/schemas/video-deep-poi-extraction-inline.txt) | Deep schema (visualTags + photoTip) |
| [apps/agentic/agent-hub/config/schemas/entity-poi-extraction-inline.txt](../../../../apps/agentic/agent-hub/config/schemas/entity-poi-extraction-inline.txt) | Entity schema (with sourceId references) |
