# Experience Pipeline — Social Post to Article

How a social media URL becomes a structured experience with POIs, micro-experiences, tips, and a static editorial article served via CDN.

## Pipeline Overview

```
Social URL (YouTube/TikTok/Instagram)
    │
    ▼
POST /api/content/extract-shape
    │
    ├── 1. Cache check ─── HIT ──► return cached JSON + HTML URL
    │
    ├── 2. Agent-hub: execute content-shape-dispatcher SOP
    │       │
    │       ▼
    │   Gemini 2.5 Flash streams NDJSON (one JSON object per line)
    │       │
    │       ├── {"type":"shape","shape":"extraction"}
    │       ├── {"type":"video-title","text":"..."}
    │       ├── {"type":"primary-location","city":"Tokyo","lat":35.68,"lng":139.69}
    │       ├── {"type":"me-start","id":1,"title":"...","duration":"3 hours",...}
    │       ├── {"type":"stop","meId":1,"name":"Sensoji Temple","videoTimestamp":"07:49",...}
    │       │       │
    │       │       ▼ (fires immediately, rate-limited 5 concurrent)
    │       │   mcp-hub /api/place-search → coordinates, image, rating, placeId
    │       │       │
    │       │       ▼ (fallback if image missing)
    │       │   mcp-hub /pois/poi-{placeId}.json → R2 cached image
    │       │
    │       ├── {"type":"stop","meId":1,"name":"Tokyo Skytree",...}  ← fires next geocode
    │       ├── ...more stops/items/tips...
    │       └── {"type":"done"}
    │
    ├── 3. Fetch video details from mcp-hub (thumbnail, author, channel avatar)
    │
    ├── 4. Assemble: flat pois[] + shape-specific containers + mentions[]
    │
    ├── 5. Write JSON to R2: experiences/{type}_{id}_i.json (stable key)
    │
    ├── 6. Render HTML from shape-matched template (extraction/listicle/stubs)
    │
    └── 7. Write HTML to R2: html/{slug}-{typeCode}-{id} (SEO key)
            │
            ▼
        Return { htmlUrl, shape, data }
```

## Instant Mode — Streaming NDJSON

The key performance optimization: the LLM streams POI names **one at a time** as NDJSON events. Each `stop`/`item`/`venue` event triggers a place-search geocode **immediately**, running in parallel with continued LLM generation.

```
Time ──────────────────────────────────────────────►

LLM:    [shape] [title] [location] [me-start] [stop1] [stop2] [stop3] ... [done]
                                       │         │       │
Geocode:                               │     [search1]  [search2]
                                       │         │       │
                                       │     [result1]  [result2]  ← coordinates + image ready

Without streaming: LLM finishes (30s) → then geocode all POIs (15s) = 45s total
With streaming:    LLM streams (30s) + geocodes overlap = ~32s total
```

A concurrency limiter (`createLimiter(5)`) caps in-flight place-search calls to protect mcp-hub's Zyte rate limit from being overwhelmed by 15+ simultaneous requests.

## Content Shapes

The dispatcher classifies each video into exactly one shape based on the content:

| Shape | When | Output | Renderer |
|-------|------|--------|----------|
| **extraction** | Vlog, day-in-the-life, travel diary with narrative flow | `pois[]` + `microExperiences[]` with `stopRefs` | Full editorial with per-ME maps |
| **listicle** | "Top N", "Best N", ranked list | `pois[]` + `items[]` with rank + proTip | Ranked rows + sticky overview map |
| **tips** | Advice, rules, cultural tips (no specific trip) | `pois[]` + `tips[]` by category | Stub (Phase 2) |
| **venue-review** | Hotel/restaurant comparison reviews | `pois[]` + `venues[]` with metrics | Stub (Phase 2) |
| **explainer** | Cultural concept, tradition explained in prose | `pois[]` + `explainerMeta` with chapters | Stub (Phase 2) |
| **guide** | Multi-creator curated guide (rare for single video) | `pois[]` + `microExperiences[]` with creator field | Stub (Phase 2) |

Classification rules (applied in order, first match wins):
1. Creator explicitly ranks things ("top N", "best N") → **listicle**
2. Creator reviews N venues of same type with comparison → **venue-review**
3. Creator giving advice/rules/tips with no specific trip → **tips**
4. Creator explaining a cultural concept in long prose → **explainer**
5. Content aggregates multiple creators → **guide**
6. Otherwise → **extraction**

## Micro-Experience Grouping (extraction shape)

MEs are the creator's narrative structure — how they organized their trip.

| Video signal | ME strategy |
|---|---|
| Clear time boundaries ("day 1", "morning", "next day") | Group by creator's time markers |
| Time-of-day hints but fuzzy boundaries | Group by geographic proximity |
| No time info (catalog-style content) | No MEs — flat POI list |
| POI geographically isolated from others | Gets its own single-stop ME |

Each ME has:
- `title` — descriptive name
- `timeOfDay` — morning/afternoon/evening/etc.
- `duration` — estimated time ("2 hours", "half day")
- `narrative` — must reference every stop with **why** the creator recommends it
- `stopRefs[]` — ordered references into `pois[]` via `poiIndex`, each with `videoTimestamp`, `quote`, `stayDuration`

## Canonical Data Model

A single unified JSON structure serves both the editorial HTML and the interactive map:

```json
{
  "shape": "extraction",
  "videoTitle": "3 Days in Tokyo...",
  "videoSummary": "...",
  "primaryLocation": "Tokyo, Japan",
  "primaryLocationCoords": { "lat": 35.68, "lng": 139.69 },

  "pois": [
    {
      "name": "Sensoji Temple",
      "neighborhood": "Asakusa",
      "category": "culture",
      "coordinates": { "lat": 35.71, "lng": 139.79 },
      "imageUrl": "http://localhost:8787/api/cached-image/media/cached-image_xxx.jpg",
      "rating": 4.5,
      "address": "...",
      "placeId": "ChIJ...",
      "sourceId": "#1",
      "mentions": [
        { "sourceIndex": 0, "quote": "...", "videoTimestamp": "07:49" }
      ]
    }
  ],
  "sources": [
    { "url": "https://youtube.com/watch?v=...", "title": "...", "type": "youtube", "image": "..." }
  ],
  "tips": [],

  "microExperiences": [
    {
      "title": "Day 1: Futuristic Art...",
      "timeOfDay": "daytime",
      "duration": "half day",
      "narrative": "On their first day, the creators started with...",
      "stopRefs": [
        { "poiIndex": 0, "videoTimestamp": "02:36", "quote": "...", "stayDuration": "2.5 hours" },
        { "poiIndex": 1, "videoTimestamp": "05:43", "quote": "...", "stayDuration": "1.5 hours" }
      ]
    }
  ],

  "_videoMeta": { "title": "...", "author": "...", "thumbnailUrl": "media/cached-image_xxx.jpg" },
  "_sourceUrl": "https://youtube.com/watch?v=...",
  "_slug": "3-days-in-tokyo-...-yt-viN5MX0-FaY",
  "_publicUrl": "https://read.fortypirates.com/3-days-in-tokyo-...-yt-viN5MX0-FaY"
}
```

Key design: **POIs are the atoms**. Shape-specific containers (MEs, items, venues) reference POIs by index, never duplicate them. This means:
- The `/explore` map editor reads `pois[]` directly
- The editorial renderer resolves `stopRefs[].poiIndex` → `pois[poiIndex]`
- Creator commentary lives on `pois[].mentions[]`, not on the shape containers
- Same JSON file serves both views

## Supported Post Types

| Platform | Status | Input | SOP |
|----------|--------|-------|-----|
| **YouTube** | Supported | Video URL → transcript via mcp-hub | `content-shape-dispatcher` |
| **TikTok** | Pending | Video URL → transcript | Same SOP (needs transcript provider) |
| **Instagram** | Pending | Reel/post URL → transcript or caption | Same SOP (needs caption extraction) |

## URL Paths

### Editorial HTML (static, CDN-direct in production)

| Env | URL | Served by |
|-----|-----|-----------|
| Production | `https://read.fortypirates.com/{slug}-{typeCode}-{id}` | R2 CDN (zero Worker cost) |
| Dev | `http://localhost:3000/experience/{slug}-{typeCode}-{id}` | Next.js route reading from `.next/cache/html/` |
| Legacy | `/experience/{type}/{id}` | 301 redirect to slug URL |

Type codes: `yt` = YouTube, `tt` = TikTok, `ig` = Instagram.

### Interactive Map (Context Map)

| Env | URL |
|-----|-----|
| All | `/explore/{type}/{id}` |

Defaults to instant mode. Examples:
- `/explore/youtube/viN5MX0-FaY` — extraction shape, 3 MEs
- `/explore/youtube/3TiOPKqtrLM` — listicle shape, 15 items


### Examples

| Video | Shape | POIs | MEs | Lang | Article (dev) | Map (dev) |
|-------|-------|------|-----|------|---------------|-----------|
| 3 Days in Tokyo (viN5MX0-FaY) | extraction | 14 | 3 | en | [article](http://localhost:3000/experience/3-days-in-tokyo-an-epic-itinerary-exploring-iconic-landmarks-yt-viN5MX0-FaY) | [map](http://localhost:3000/explore/youtube/viN5MX0-FaY) |
| Tokyo Top 15 (3TiOPKqtrLM) | listicle | 15 | — | en | [article](http://localhost:3000/experience/tokyo-s-top-15-must-visit-attractions-yt-3TiOPKqtrLM) | [map](http://localhost:3000/explore/youtube/3TiOPKqtrLM) |
| Best Things Tokyo (CvgC6z8Wrxw) | listicle | 21 | — | en | [article](http://localhost:3000/experience/best-things-to-do-in-tokyo-for-a-first-time-visit-yt-CvgC6z8Wrxw) | [map](http://localhost:3000/explore/youtube/CvgC6z8Wrxw) |
| Shizuoka Hidden Gems (4gcPpraTwRo) | extraction | 10 | 4 | en | [article](http://localhost:3000/experience/exploring-shizuoka-s-hidden-gems-thomas-fair-okuoi-kojo-stat-yt-4gcPpraTwRo) | [map](http://localhost:3000/explore/youtube/4gcPpraTwRo) |
| Tokyo Day Back (MuBcNrIRi_U) | extraction | 9 | 5 | en | [article](http://localhost:3000/experience/our-first-day-back-in-tokyo-yt-MuBcNrIRi_U) | [map](http://localhost:3000/explore/youtube/MuBcNrIRi_U) |
| 徒步東海道 (RG2g7J0SIjg) | extraction | 17 | 7 | zh | [article](http://localhost:3000/experience/徒步東海道-從日本橋到川崎宿-追尋歌川廣重與幕末歷史的足跡-yt-RG2g7J0SIjg) | [map](http://localhost:3000/explore/youtube/RG2g7J0SIjg) |

Notes:
- CJK titles produce CJK slugs (URL-encoded by browser, works in all modern browsers)
- Map URL defaults to instant mode — no `?mode=instant` needed
- Same JSON file serves both the article and the map

### R2 Storage

```
fortypirates-apps/
├── experiences/                         ← JSON (internal, stable key)
│   ├── youtube_viN5MX0-FaY_i.json
│   ├── youtube_3TiOPKqtrLM_i.json
│   └── _index.json                      ← manifest (optional)
│
├── html/                                ← HTML (public CDN, slug-keyed)
│   ├── 3-days-in-tokyo-...-yt-viN5MX0-FaY
│   └── tokyo-s-top-15-...-yt-3TiOPKqtrLM
```

CDN domain: `read.fortypirates.com` → R2 bucket `fortypirates-apps`.
Transform Rule rewrites `/{path}` → `/html/{path}` before hitting R2.

### Shortlinks (planned)

| Domain | URL | Action |
|--------|-----|--------|
| `40p.to` | `/e/yt{id}` | 301 → canonical editorial URL |
| `40p.to` | `/@{creator}` | Creator bio page (existing) |

## Key Files

| File | Purpose |
|------|---------|
| `apps/agentic/agent-hub/config/recipes/content-shape-dispatcher.md` | SOP: shape classification + NDJSON streaming |
| `apps/web/app/api/content/extract-shape/route.ts` | Orchestrator: stream → assemble → geocode → render → cache |
| `apps/web/lib/shape-dispatcher/ndjson-assembler.ts` | NDJSON parser, POI dedup, mention attachment |
| `apps/web/lib/shape-renderers/shared.ts` | Types (Poi, PoiRef, MicroExperience, etc.), CSS tokens, banner |
| `apps/web/lib/shape-renderers/extraction.ts` | Extraction shape → HTML renderer |
| `apps/web/lib/shape-renderers/listicle.ts` | Listicle shape → HTML renderer |
| `apps/web/lib/shape-renderers/stubs.ts` | Stub renderer for unimplemented shapes |
| `apps/web/lib/shape-renderers/index.ts` | Shape dispatcher (switch on shape → renderer) |
| `apps/web/app/experience/[...slug]/route.ts` | Dev HTML serve + legacy redirect |
| `apps/web/app/explore/[type]/[name]/page.tsx` | Map editor page (reads same JSON) |
| `apps/web/components/captures/context-map/ContextMapPage.tsx` | Interactive map with ME tab |
| `apps/web/components/captures/context-map/PoiSidebar.tsx` | Sidebar: Places, Experiences, Tips tabs |
| `apps/web/components/captures/context-map/PoiDetailPanel.tsx` | POI detail with mentions feed |
| `docs/assets/drawer.css` / `drawer.js` | Slide-in drawer (shared across editorial pages) |

## Design Decisions

1. **One JSON, two views.** Same `experiences/{type}_{id}_i.json` serves both the editorial HTML and the map editor. No sync issues.

2. **POIs are atoms, MEs are groupings.** POIs carry static data (coordinates, rating, image). MEs carry editorial data (narrative, time, order). Shape containers reference POIs by index, never duplicate.

3. **Mentions accumulate.** Each POI has `mentions[]` — creator commentary from different sources. When a user saves a POI from two different videos, both mentions travel with it.

4. **CDN-first for editorial pages.** HTML is a static file in R2, served via `read.fortypirates.com` with zero Worker cost. Only the extraction API route runs Workers code.

5. **English default, multi-language planned.** SOP outputs English regardless of source language. Future: `/{lang}/` prefix in R2 keys, browser `Accept-Language` → SOP `{{language}}` param.

6. **Streaming geocode.** NDJSON lets place-search fire per-POI as the LLM generates, not after. Saves 10-15 seconds on a 15-POI extraction.
