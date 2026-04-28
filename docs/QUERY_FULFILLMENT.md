# Query Fulfillment Architecture

**Overview:** The system processes multiple input types (YouTube URLs, entity queries, links, images) through a multi-stage pipeline to extract POIs, sources, and metadata.

```
Input Detection → Content Extraction → LLM Processing → POI Enrichment → Client Display
     ↓                  ↓                    ↓                  ↓              ↓
  URL/Query        Transcript/         Structured        Geocoding      Map + Cards
  Pattern          Web Content         JSON Output       + Images       with Sources
```

## Table of Contents

- [Input Types & Processing Paths](#input-types--processing-paths)
- [Processing Flow Details](#processing-flow-details)
- [Caching Layers](#caching-layers)
- [API Communication Patterns](#api-communication-patterns)
- [Performance Optimizations](#performance-optimizations)
- [Key Files Reference](#key-files-reference)

---

## Input Types & Processing Paths

The frontend detects input patterns and routes them to appropriate SOPs (Standard Operating Procedures):

| Input Type | Detection Pattern | SOP Used | Cache Key Format | Output |
|------------|-------------------|----------|------------------|--------|
| **YouTube URL** | `youtube.com/watch` or `youtu.be` | `youtube-poi-extraction` (fast) or `youtube-deep-poi-extraction` (deep) | `youtube-poi/{videoId}_{mode}_{hash}.json` | POIs with timestamps, transcript segments |
| **Entity Query** | `/anime name`, `/movie title`, `/celebrity name` | `entity-poi-extraction` | `entity-poi/{type}_{name}_{hash}.json` | POIs with descriptions, no timestamps |
| **Direct Link** | `https://...` (non-YouTube) | `generic-url-poi-extraction` | `generic-poi-{hash}.json` | POIs from web content |
| **Image URL** | Ends with `.jpg`, `.png`, etc. | `image-spatial-intelligence` | `image-poi-{hash}.json` | POIs from visual analysis |
| **TikTok URL** | `tiktok.com/@.../video/...` | `tiktok-video-poi-extraction` | `tiktok-poi-{videoId}_{hash}.json` | POIs with timestamps |
| **Keyword Search** | None of the above | `google-search-poi-extraction` | `search-poi-{hash}.json` | POIs from search results |

---

## Processing Flow Details

### 1. Frontend Input Detection

**File:** `apps/web/public/home-design/map.js` (lines ~1560)

```javascript
// URL pattern matching
const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch|youtu\.be\/)/;
const entityCommandRegex = /^(\/(anime|movie|celebrity)\s+)/i;

if (youtubeRegex.test(input)) {
  // YouTube processing path
  extractionMode = 'fast';  // or 'deep' for multimodal
} else if (entityCommandRegex.test(input)) {
  // Entity processing path
  const [_, type, ...nameParts] = input.split(' ');
  entityType = type.substring(1);  // Remove leading slash
  entityName = nameParts.join(' ');
} else if (input.startsWith('http')) {
  // Generic URL processing
}
```

### 2. Content Extraction

The web app API (`/api/context-map/extract`) routes to agent-hub which orchestrates content fetching:

#### Transcript Extraction (MCP Hub)

**File:** `apps/mcp/mcp-hub/src/api/api-youtube.ts`
**Endpoint:** `GET /api/youtube/transcript?url=<video_url>`

```typescript
// Cache key format
const cacheKey = `youtube/youtube-transcript_${videoId}.json`;

// Returns
{
  transcript: string;        // Full transcript text
  segments: Array<{          // Timestamped segments
    text: string;
    start: number;
    duration: number;
  }>;
  metadata: {
    title: string;
    author: string;
    duration: number;
  };
}
```

**Cache:** R2 bucket `crawl_data`, 1 year TTL
**Fallback:** ScrapeCreators API → Direct YouTube parsing

#### Video Metadata (MCP Hub)

**Endpoint:** `GET /api/youtube/detail?url=<video_url>`

```typescript
// Cache key format
const cacheKey = `youtube/youtube-detail_${videoId}.json`;

// Returns
{
  title: string;
  author: string;
  thumbnailUrl: string;
  duration: number;
  viewCount: number;
  publishDate: string;
}
```

**Cache:** R2 bucket `crawl_data`, 24 hour TTL

#### Web Content (Agent Hub)

For generic URLs and entity queries:
- Uses browser rendering for dynamic content
- Extracts text, images, links
- Cache per content hash

### 3. LLM Processing (SOP Execution)

**File:** `apps/agentic/agent-hub/src/app/api/execute-sop/route.ts`

#### SOP Selection

SOPs are defined in `apps/agentic/agent-hub/config/sops/`:

| SOP File | Purpose | Input | Output |
|----------|---------|-------|--------|
| `youtube-poi-extraction-inline.txt` | Fast transcript mode | Transcript text | POIs with timestamps |
| `youtube-deep-poi-extraction.txt` | Multimodal video analysis | Video frames + audio | POIs with visual descriptions |
| `entity-poi-extraction-inline.txt` | Entity-focused extraction | Web search results | POIs with descriptions |
| `generic-url-poi-extraction.txt` | Web content extraction | URL content | POIs from web page |
| `tiktok-video-poi-extraction.txt` | TikTok processing | TikTok video | POIs with timestamps |

#### Structured Output Format

All SOPs return structured JSON:

```typescript
{
  pois: Array<{
    name: string;
    description?: string;
    location?: string;
    timelineSeconds?: number;
    sourceId: string;           // Index-based: "#1", "#2", "#1, #3"
    imageUrl?: string;
    coordinates?: { lat: number; lng: number };
    placeId?: string;
    cid?: string;
  }>;
  sources: Array<{
    title: string;
    url: string;
    type: 'youtube' | 'web' | 'image';
    timestamp?: number;
  }>;
  primaryLocation?: string;
  primaryLocationCoords?: { lat: number; lng: number };
}
```

**Source-POI Association Pattern:**

POIs reference sources by index-based IDs to prevent JSONB bloat:

```javascript
// Instead of storing source title in each POI
{
  pois: [{ name: "Place A", sourceTitle: "Very Long Source Title That Repeats" }]
}

// Store index reference
{
  pois: [{ name: "Place A", sourceId: "#1" }],
  sources: [{ title: "Very Long Source Title That Repeats" }]
}
```

### 4. POI Enrichment (Geocoding + Images)

#### Geocoding (MCP Hub)

**File:** `apps/mcp/mcp-hub/src/api/api-travel.ts`
**Endpoint:** `GET /api/place-search?name=<query>&lat=<lat>&lng=<lng>`

```typescript
// Cache key format
const hashInput = `tbm_map_v15_${query.toLowerCase().replace(/\s+/g, "+")}_${lat}_${lng}`;
const cacheKey = `place-search/${query}/${hashInput}.json`;

// Also caches by place_id for reusability
const poiKey = `poi/${placeId}.json`;

// Returns
{
  name: string;
  coordinates: { latitude: number; longitude: number };
  place_id: string;
  cid: string;
  image: string;
  googleImage: string;
  rating: number;
  reviewCount: number;
  address: string;
  phone: string;
  website: string;
}
```

**Cache Strategy:**
- Query-based cache: `place-search/{query}_{lat}_{lng}.json` (search artifact)
- Place-based cache: `poi-{placeId}.json` (reusable entity)
- Client-side batching: 4 concurrent requests to avoid rate limiting

#### Image Fallback Chain

1. **Google Maps POI image** (native, from place search)
2. **Google Images search** (`tbm=isch`)
3. **Premium image sources**

### 5. Client Display

**File:** `apps/web/public/home-design/map.js`

```javascript
// POI Cards
addPoiCard(poi);  // Renders card with image, description, source link

// Context Map
L.marker([lat, lng]).addTo(map);  // Leaflet map with clustered markers

// Source Filtering
sources.map((source, idx) => {
  // Click source to filter associated POIs
  const sourceId = `#${idx + 1}`;
  const filteredPois = pois.filter(p => p.sourceId?.includes(sourceId));
});

// Progress Tracking
addLog('Extracting transcript...', 'system');
addLog('Resolving locations...', 'info');
```

---

## Caching Layers

Multi-level caching from browser to origin:

```
Browser Cache → Cloudflare CDN → Web App API → Agent/MCP Hub → R2 → Origin
     (24h)            (24h)          (R2_BUCKET)      (AGENT_CONFIGS)    (crawl_data)
   immutable      auto-purge        Proxy            Data              External
```

### Cache Hierarchy

| Layer | Location | Binding | TTL | Invalidation |
|-------|----------|---------|-----|--------------|
| **Browser** | Client HTTP cache | - | 24h (immutable) | Manual refresh |
| **Cloudflare CDN** | Edge | Automatic | 24h | Deploy/purge |
| **Web App** | R2 | `R2_BUCKET` | Per-entity | Admin publish |
| **Agent Hub** | R2 | `AGENT_CONFIGS` | Until SOP change | Hash-based |
| **MCP Hub** | R2 | `crawl_data` | 1yr (transcript) | Manual |
| **Local Dev** | Filesystem | `.next/cache/` | Session | Restart |

### Cache Key Formats

```typescript
// YouTube results (Agent Hub)
`_cache/youtube-poi/${videoId}_${mode}_${sopHash}.json`
// mode: 'f' (fast/transcript) or 'd' (deep/multimodal)
// sopHash: SHA256 of SOP configuration (changes when prompts/tools change)

// Entity results (Agent Hub)
`_cache/entity-poi/${type}_${name}_${sopHash}.json`
// type: anime, movie, celebrity, general

// Place search (MCP Hub)
`place-search/${query}_${lat}_${lng}.json`  // Query-specific artifact
`poi-${placeId}.json`                        // Reusable entity cache
`place-cid-${cid}.json`                     // CID-based cache

// YouTube data (MCP Hub)
`youtube/youtube-transcript_${videoId}.json`   // 1 year TTL
`youtube/youtube-detail_${videoId}.json`       // 24 hour TTL
```

### SOP Hash Calculation

The SOP hash ensures cache invalidation when prompts change:

```typescript
import CryptoJS from 'crypto-js';

const sopContent = fs.readFileSync(sopPath, 'utf-8');
const sopHash = CryptoJS.SHA256(sopContent).toString().substring(0, 8);
// Example: "a3f7e2b1"
```

When SOP files are updated, the hash changes, causing a cache miss and fresh extraction.

### Cache Check Flow (extract/route.ts)

When a user submits a URL or query, the API route checks the cache **before** calling agent-hub. This is the exact sequence:

#### Step 1: Input Detection & SOP Selection

```typescript
// Input type determines the SOP and effective mode
if (query) {
  sopId = 'entity-poi-extraction';
  effectiveMode = 'fast';
} else if (image) {
  sopId = 'image-spatial-intelligence';
  effectiveMode = 'deep';
} else if (videoUrl) {
  // instant/fast → video-instant-poi-extraction (streams POI names)
  // deep → video-deep-poi-extraction (returns full JSON)
  sopId = effectiveMode === 'deep'
    ? 'video-deep-poi-extraction'
    : 'video-instant-poi-extraction';
}
```

#### Step 2: Build Cache Key

Cache keys are built from the parsed input, **not** the raw URL. The key includes the extraction mode so fast/deep/instant caches are separate:

```typescript
// YouTube: uses videoId extracted from URL
const parsed = parseVideoUrl(videoUrl);  // e.g., { type: 'youtube', id: 'dQw4w9WgXcQ' }
cacheKey = buildCacheKey(parsed.type, parsed.id, effectiveMode);
// → 'experiences/youtube_dQw4w9WgXcQ_f.json'  (fast/instant)
// → 'experiences/youtube_dQw4w9WgXcQ_d.json'  (deep)

// Entity: uses type + compact name from query
const parsed = parseEntityQuery(query);  // e.g., { type: 'anime', compactName: 'yourname' }
cacheKey = buildCacheKey('entity', `${parsed.type}_${parsed.compactName}`);
// → 'experiences/entity_anime_yourname.json'
```

#### Step 3: Cache Read (R2 in production, local FS in dev)

```typescript
// Production: reads from R2_BUCKET binding
const cached = await readCache(cacheKey, env);

// Local dev: reads from .next/cache/experiences/{cacheKey}
// env is empty when not on Cloudflare, so local FS fallback is used
```

#### Step 4a: Cache HIT — Instant Mode

When a cached result exists **and** it was produced by instant mode (`cached._instant === true`), the cached POI **names** are re-geocoded via NDJSON stream, but the LLM extraction is skipped entirely:

```typescript
if (effectiveMode === 'instant' && cached._instant) {
  // Re-geocode the cached POI names in parallel via place-search
  // Resolves location bias from cached primaryLocationCoords
  const bias = cached.primaryLocationCoords
    || await resolveLocationBias(cached.primaryLocation, mcpHub);

  const stream = createGeocodingStream(
    cached.pois || [],             // Array of { name, location? }
    cached.primaryLocation || '',
    cached.recommendedAirportCode || '',
    cached._videoMeta,             // Cached video metadata
    mcpHub,
    undefined,
    bias,
  );

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  });
}
```

**Why re-geocode?** The cached data stores POI names but coordinates and images from place-search may change over time. Re-geocoding ensures fresh coordinates and images while skipping the expensive LLM extraction.

**Cached instant data structure:**
```typescript
{
  pois: Array<{ name: string; location?: string }>,  // POI names only
  primaryLocation: string,
  primaryLocationCoords?: { lat: number; lng: number },
  recommendedAirportCode?: string,
  _videoMeta?: { title, thumbnailUrl, channelThumbnailUrl, ... },
  _instant: true,                    // Marks this as an instant-mode cache entry
  _rawText: string,                  // Raw LLM output for debugging
}
```

#### Step 4b: Cache HIT — Deep/Fast/Entity Mode

For non-instant modes, the cached JSON is returned directly with a `_cached: true` flag:

```typescript
return NextResponse.json({
  ...cached,
  _videoMeta: resolveVideoMetaUrls(cached._videoMeta),  // R2 keys → CDN URLs
  _cached: true,                                         // Tells frontend it's cached
});
```

The frontend can check `_cached: true` to show a "cached" indicator or skip showing extraction progress.

#### Step 5: Cache MISS — Fresh Extraction

If no cache entry exists, the full pipeline runs:

```
1. Call agent-hub POST /api/execute-sop with { sopId, inputs, extractionMode }
2. For instant mode: parse agent-hub's streamed output line-by-line,
   geocode each POI as it arrives, stream results to client as NDJSON
3. For deep mode: wait for agent-hub's full JSON response
4. Cache write (background, non-blocking):
   writeCache(cacheKey, data, env).catch(() => {});
```

**Cache write is fire-and-forget** — the response is returned to the client immediately, and the cache write happens asynchronously. If the cache write fails, it's silently ignored (the next request will simply re-extract).

#### Deep Mode Fallback

If instant/fast mode fails because no transcript is available, the system retries with deep mode:

```typescript
if ((effectiveMode === 'instant' || effectiveMode === 'fast')
    && errMsg.includes('transcript')) {
  // Retry with deep mode SOP
  sopId = 'video-deep-poi-extraction';
  const deepResponse = await agentHub.fetch('/api/execute-sop', {
    body: JSON.stringify({ sopId, inputs, extractionMode: 'deep', videoMeta }),
  });

  // Cache under the DEEP mode key (separate from instant/fast cache)
  const deepCacheKey = buildCacheKey(parsed.type, parsed.id, 'deep');
  writeCache(deepCacheKey, data, env).catch(() => {});

  // Signal mode change to client via header
  return NextResponse.json(data, {
    headers: { 'X-Extraction-Mode': 'deep' },
  });
}
```

This means the same video can have **two separate cache entries**: one for instant/fast mode and one for deep mode.

### Cache Key Reference (buildCacheKey)

**File:** `apps/web/lib/experience-cache.ts`

| Input Type | Parsed By | Cache Key |
|------------|-----------|-----------|
| YouTube URL | `parseVideoUrl()` | `experiences/youtube_{videoId}_{mode}.json` |
| TikTok URL | `parseVideoUrl()` | `experiences/tiktok_{videoId}_{mode}.json` |
| Instagram URL | `parseVideoUrl()` | `experiences/instagram_{shortcode}_{mode}.json` |
| Entity query | `parseEntityQuery()` | `experiences/entity_{type}_{compactName}.json` |
| Image | N/A | No cache key (always fresh) |

**Mode values:** `f` (fast/instant), `d` (deep), `i` (image — unused)

---

## API Communication Patterns

### Frontend → Web App API

**File:** `apps/web/app/api/context-map/extract/route.ts`

```typescript
POST /api/context-map/extract
Content-Type: application/json

{
  input: string;           // User input (URL, entity query, etc.)
  extractionMode: 'fast' | 'deep';
  videoMeta?: {            // Optional pre-supplied metadata
    title: string;
    thumbnailUrl: string;
    author: string;
  };
}

Response: {
  pois: POI[];
  sources: Source[];
  videoMeta?: VideoMetadata;
  primaryLocation?: string;
}
```

### Web App → Agent Hub

**File:** `apps/agentic/agent-hub/src/app/api/execute-sop/route.ts`

```typescript
POST /api/execute-sop
Content-Type: application/json

{
  sopName: string;         // e.g., "youtube-poi-extraction"
  input: string;           // URL, transcript, or query
  extractionMode: string;  // "fast" or "deep"
  context: {
    videoMeta?: object;
    primaryLocation?: string;
    coords?: { lat: number; lng: number };
  };
}

Response: {
  result: { pois: POI[]; sources: Source[]; ... };
  usage: { promptTokens: number; completionTokens: number };
}
```

### Web App → MCP Hub

**YouTube APIs** (`apps/mcp/mcp-hub/src/api/api-youtube.ts`):
```typescript
GET /api/youtube/transcript?url=<video_url>
GET /api/youtube/detail?url=<video_url>
GET /api/youtube/search?q=<query>
```

**Place APIs** (`apps/mcp/mcp-hub/src/api/api-travel.ts`):
```typescript
GET /api/place-search?name=<query>&lat=<lat>&lng=<lng>&allowMapResultImage=true
GET /api/place-autocomplete?q=<query>&lat=<lat>&lng=<lng>
GET /api/place-by-cid?cid=<cid>
GET /api/place-discovery?location=<name>&query=<type>
```

### Client → MCP Hub (Direct)

**File:** `apps/web/public/home-design/map.js`

The homepage bypasses the web app API and calls MCP Hub directly for geocoding:

```javascript
const isLocalhost = window.location.hostname === 'localhost' || '127.0.0.1';
const mcpHub = isLocalhost
  ? 'http://localhost:8787'
  : 'https://mcp-hub.rayhon1014.workers.dev';

// Batch geocoding with concurrency limit
const CONCURRENCY_LIMIT = 4;
for (let i = 0; i < pois.length; i += CONCURRENCY_LIMIT) {
  const batch = pois.slice(i, i + CONCURRENCY_LIMIT);
  await Promise.all(batch.map(async (poi) => {
    const searchUrl = `${mcpHub}/api/place-search?name=${query}&allowMapResultImage=true`;
    const response = await fetch(searchUrl);
    // ...
  }));
}
```

---

## Performance Optimizations

### 1. Pre-supplied Metadata

When searching YouTube, the metadata (title, thumbnail) is included with search results to avoid redundant API calls:

```typescript
// User clicks search result → metadata passed to extraction
{
  input: "https://youtube.com/watch?v=xxx",
  videoMeta: {
    title: "Japan Travel 2024",
    thumbnailUrl: "https://i.ytimg.com/vi/xxx/hq720.jpg"
  }
}

// Skips the /api/youtube/detail call
```

### 2. Parallel Geocoding with Concurrency Limit

```javascript
// Before: All requests fire at once (20+ parallel)
await Promise.all(pois.map(p => fetchPlaceSearch(p)));

// After: Batched to 4 concurrent (avoids rate limiting)
const BATCH_SIZE = 4;
for (let i = 0; i < pois.length; i += BATCH_SIZE) {
  await Promise.all(pois.slice(i, i + BATCH_SIZE).map(fetchPlaceSearch));
}
```

### 3. Smart Caching

Different TTLs per data type:
- **Transcripts:** 1 year (content doesn't change)
- **Video details:** 24 hours (view counts update)
- **POI data:** 24 hours (business info changes occasionally)
- **Browser cache:** immutable (revalidated on refresh)

### 4. Source Deduplication

Index-based references prevent JSONB bloat:
- POIs store `sourceId: "#1"` instead of `sourceTitle: "Full Title"`
- Sources array stored once
- Significant storage savings for videos with many POIs

### 5. Cache-Control Headers

```typescript
// API responses include browser caching directives
Cache-Control: public, max-age=86400, stale-while-revalidate=604800, immutable

// max-age=86400: Cache for 24 hours
// stale-while-revalidate=604800: Serve stale for 7 days while revalidating
// immutable: Resource never changes (for static assets)
```

---

## Key Files Reference

### Frontend (Homepage)

| File | Purpose |
|------|---------|
| `apps/web/public/home-design/index.html` | Static homepage UI |
| `apps/web/public/home-design/map.js` | Extraction logic, geocoding, map rendering |

### Web App API

| File | Purpose |
|------|---------|
| `apps/web/app/api/context-map/extract/route.ts` | Routes extraction requests to agent-hub |
| `apps/web/app/api/entity-cache/[type]/[name]/route.ts` | Cached entities with stats, geocoding |
| `apps/web/lib/service-fetcher.ts` | Service communication (agent-hub, mcp-hub) |

### Agent Hub

| File | Purpose |
|------|---------|
| `apps/agentic/agent-hub/src/app/api/execute-sop/route.ts` | SOP execution, LLM orchestration |
| `apps/agentic/agent-hub/config/sops/*.txt` | Prompt templates for each extraction type |
| `apps/agentic/agent-hub/src/lib/cache/` | R2 + filesystem caching |

### MCP Hub

| File | Purpose |
|------|---------|
| `apps/mcp/mcp-hub/src/api/api-youtube.ts` | Transcript, metadata, search |
| `apps/mcp/mcp-hub/src/api/api-travel.ts` | Place search, geocoding, autocomplete |
| `apps/mcp/mcp-hub/src/services/place/place-service.ts` | Place data enrichment |
| `apps/mcp/mcp-hub/src/services/crawler/` | Web scraping, proxy handling |

---

## Related Documentation

- **[Entity Cache System](ENTITY_CACHE_SYSTEM.md)** - R2-first caching, curated versions
- **[Context Maps & POI Management](CONTEXT_MAP_POI.md)** - Map visualization, source filtering
- **[Service Integration](SERVICE_INTEGRATION.md)** - Agent-hub, MCP-hub communication
- **[Source-POI Association Pattern](../../MEMORY.md)** - Index-based references
