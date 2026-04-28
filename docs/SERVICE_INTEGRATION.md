# Service Integration Design

## Overview

The web application integrates with two external services to provide AI-powered features:

1. **agent-hub** - SOP execution, entity caching, AI orchestration
2. **mcp-hub** - MCP tools, place search, geocoding

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web App (Next.js)                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Context Maps │  │  Explore     │  │  Workspace   │          │
│  └───────┬──────┘  └──────┬───────┘  └──────┬───────┘          │
│          │                │                  │                   │
│          ▼                ▼                  ▼                   │
│  ┌───────────────────────────────────────────────────────┐      │
│  │              Service Fetcher Pattern                  │      │
│  │  ┌─────────────────┐      ┌─────────────────┐        │      │
│  │  │ AGENT_HUB_URL   │      │ MCP_HUB_URL     │        │      │
│  │  └────────┬────────┘      └────────┬────────┘        │      │
│  └───────────┼───────────────────────┼──────────────────┘      │
└──────────────┼───────────────────────┼──────────────────────────┘
               │                       │
               ▼                       ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│      agent-hub           │  │       mcp-hub            │
│  Port: 51957             │  │  Port: 8787              │
│                          │  │                          │
│  • SOP Execution         │  │  • Place Search          │
│  • Entity Cache (R2)     │  │  • Geocoding             │
│  • LLM Orchestration     │  │  • MCP Tools             │
└──────────────────────────┘  └──────────────────────────┘
```

## Service Fetcher Pattern

### Implementation

**Location:** `apps/web/lib/service-fetcher.ts`

```typescript
interface ServiceFetcher {
  baseUrl: string;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

export function getServiceFetcher(
  envKey: string,
  urlKey: string,
  defaultUrl: string
): ServiceFetcher {
  const baseUrl = process.env[urlKey] || defaultUrl;

  return {
    baseUrl,
    fetch: async (path: string, init?: RequestInit) => {
      const url = `${baseUrl}${path}`;
      const response = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...init?.headers,
        },
      });

      if (!response.ok) {
        throw new Error(`Service error: ${response.status} ${response.statusText}`);
      }

      return response;
    },
  };
}
```

### Usage

```typescript
import { getServiceFetcher } from '@/lib/service-fetcher';

// Agent Hub
const agentHub = getServiceFetcher('AGENT_HUB', 'AGENT_HUB_URL', 'http://localhost:51957');
const response = await agentHub.fetch('/api/entity-cache/anime/your-name');
const data = await response.json();

// MCP Hub
const mcpHub = getServiceFetcher('MCP_HUB', 'MCP_HUB_URL', 'http://localhost:8787');
const place = await mcpHub.fetch('/api/place-search?name=Tokyo');
```

### Environment Variables

Configure in `.env.local`:

```bash
# Agent Hub (SOP execution, entity cache)
AGENT_HUB_URL=http://localhost:51957

# MCP Hub (place search, geocoding)
MCP_HUB_URL=http://localhost:8787

# Optional: Override for production
# AGENT_HUB_URL=https://agent-hub.example.com
# MCP_HUB_URL=https://mcp-hub.example.com
```

## Agent Hub Integration

### Purpose

Agent Hub handles AI-powered content processing and caching:

- **SOP Execution**: Run Standard Operating Procedures for entity extraction
- **Entity Caching**: R2-based cache with hash-based keys
- **LLM Orchestration**: Route requests to appropriate AI models
- **Chat/Streaming**: Real-time AI responses

### Key Endpoints

#### Entity Cache

```
GET /api/entity-cache/{type}/{name}
```

**Purpose:** Retrieve cached entity data

**Request:**
```typescript
const agentHub = getServiceFetcher('AGENT_HUB', 'AGENT_HUB_URL', 'http://localhost:51957');
const response = await agentHub.fetch(`/api/entity-cache/anime/your-name`);
```

**Response:**
```json
{
  "entityName": "Your Name",
  "entityType": "anime",
  "pois": [...],
  "sources": [...],
  "cacheSource": "curated"
}
```

**Cache Source Values:**
- `curated` - Admin-published version from R2
- `hash` - User-generated cached version from R2
- `local` - Development filesystem cache

#### SOP Execution

```
POST /api/execute-sop
```

**Purpose:** Execute a Standard Operating Procedure

**Request:**
```typescript
const response = await agentHub.fetch('/api/execute-sop', {
  method: 'POST',
  body: JSON.stringify({
    sop: 'entity-poi-extraction',
    entityType: 'anime',
    entityName: 'Your Name',
    content: 'Movie description, plot, etc.'
  })
});
```

**Response:**
```json
{
  "success": true,
  "data": {
    "entityName": "Your Name",
    "entityType": "anime",
    "pois": [...],
    "sources": [...]
  },
  "cacheKey": "_cache/entity-poi/anime_your-name_a1b2c3d4.json"
}
```

#### Chat Orchestration

```
POST /api/chat
```

**Purpose:** Stream AI responses for user queries

**Request:**
```typescript
const response = await agentHub.fetch('/api/chat', {
  method: 'POST',
  body: JSON.stringify({
    messages: [
      { role: 'user', content: 'Find POIs from the movie Your Name' }
    ],
    stream: true
  })
});

// Handle streaming response
const reader = response.body.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = new TextDecoder().decode(value);
  // Process SSE chunks
}
```

### SOP Configuration

**Location:** `apps/agentic/agent-hub/config/schemas/`

Entity POI Extraction Schema:
```
File: entity-poi-extraction-inline.txt

Output format specification for LLM:
- Extract POIs with addresses
- Identify sources
- Use 1-based index for source references
- Include descriptions and images
```

**Cache Key Generation:**

Hash is derived from:
- SOP version identifier
- Model versions (Claude, GPT)
- Tool configurations
- Schema definitions

```typescript
const hashInput = `${sopVersion}-${modelVersion}-${schemaHash}`;
const cacheKey = `_cache/entity-poi/${type}_${name}_${hash(hashInput)}.json`;
```

## MCP Hub Integration

### Purpose

MCP Hub provides location-based services:

- **Place Search**: Find places by name or address
- **Geocoding**: Convert addresses to coordinates
- **Reverse Geocoding**: Convert coordinates to addresses
- **Place Details**: Get detailed information about places

### Key Endpoints

#### Place Search

```
GET /api/place-search?name={name}
GET /api/place-search?address={address}
```

**Purpose:** Search for places and get coordinates

**Request:**
```typescript
const mcpHub = getServiceFetcher('MCP_HUB', 'MCP_HUB_URL', 'http://localhost:8787');
const response = await mcpHub.fetch(
  '/api/place-search?name=Suga+Shrine+Shinjuku'
);
```

**Response:**
```json
{
  "name": "Suga Shrine",
  "address": "Yotsuya, Shinjuku, Tokyo, Japan",
  "coordinates": {
    "lat": 35.6894,
    "lng": 139.7164
  },
  "placeId": "ChIJ7711...",
  "types": ["religious", "shrine"]
}
```

#### Batch Geocoding

For efficiency, geocode multiple POIs in parallel:

```typescript
const poisWithoutCoords = pois.filter(p => !p.coords && p.address);

// Batch size of 5 for rate limiting
const batches = chunk(poisWithoutCoords, 5);

for (const batch of batches) {
  const results = await Promise.all(
    batch.map(poi =>
      mcpHub.fetch(`/api/place-search?address=${encodeURIComponent(poi.address)}`)
    )
  );

  results.forEach((result, i) => {
    if (result.coordinates) {
      batch[i].coords = result.coordinates;
    }
  });
}
```

## Web App API Layer

### Entity Cache Proxy

**Location:** `apps/web/app/api/entity-cache/[type]/[name]/route.ts`

The web app proxies requests to agent-hub and adds enhancements:

```typescript
// 1. Fetch from agent-hub
const agentHub = getServiceFetcher('AGENT_HUB', 'AGENT_HUB_URL', 'http://localhost:51957');
const response = await agentHub.fetch(`/api/entity-cache/${type}/${name}`);
let entityData = await response.json();

// 2. Add geocoding (via mcp-hub)
const mcpHub = getServiceFetcher('MCP_HUB', 'MCP_HUB_URL', 'http://localhost:8787');
for (const poi of entityData.pois.filter(p => !p.coords && p.address)) {
  const geoResponse = await mcpHub.fetch(
    `/api/place-search?address=${encodeURIComponent(poi.address)}`
  );
  const geoData = await geoResponse.json();
  if (geoData.coordinates) {
    poi.coords = geoData.coordinates;
  }
}

// 3. Add stats (from database)
const stats = await getEntityStats(type, name);

// 4. Return enhanced data
return NextResponse.json({ ...entityData, stats });
```

### Error Handling

```typescript
try {
  const agentHub = getServiceFetcher('AGENT_HUB', 'AGENT_HUB_URL', 'http://localhost:51957');
  const response = await agentHub.fetch(`/api/entity-cache/${type}/${name}`);

  if (!response.ok) {
    if (response.status === 404) {
      // Trigger SOP execution for cache miss
      return await executeSopAndCache(type, name);
    }
    throw new Error(`Agent hub error: ${response.status}`);
  }

  return await response.json();
} catch (error) {
  console.error('[ServiceIntegration] Error:', error);
  return NextResponse.json(
    { error: 'Failed to fetch entity data' },
    { status: 500 }
  );
}
```

## Inter-Service Communication Flow

### Entity Discovery Flow

```
User: "/anime Your Name"
    ↓
Web App Homepage
    ↓
Check cache: GET /api/entity-cache/anime/your-name
    ↓
Agent Hub: Check R2 for curated → hash → local
    ↓
[Cache Miss] → Execute SOP
    ↓
Agent Hub → LLM (Claude)
    - Extract POIs from content
    - Identify sources
    - Index sources (1, 2, 3...)
    - Associate POIs with sourceId
    ↓
Agent Hub → Cache: _cache/entity-poi/anime_your-name_{hash}.json
    ↓
Web App: GET /api/entity-cache/anime/your-name
    ↓
Web App → MCP Hub: Geocode POIs without coordinates
    ↓
Web App → Database: Fetch stats (likes, clones)
    ↓
Web App → Explore Page: Render map with POIs
```

### Chat to Context Map Flow

```
User: "Find filming locations from Your Name"
    ↓
Web App → Agent Hub: POST /api/chat
    ↓
Agent Hub: Route to entity-poi-extraction SOP
    ↓
LLM: Extract POIs, format response
    ↓
Agent Hub: Stream response + cache entity
    ↓
Web App: Display streaming response
    ↓
User: Click "Create Map"
    ↓
Web App: Create capture with entity data
    ↓
Web App: Redirect to /capture/{captureId}
```

## Monitoring & Observability

### Logging

```typescript
console.log('[ServiceIntegration] Fetching entity:', { type, name });
console.log('[ServiceIntegration] Cache source:', cacheSource);
console.log('[ServiceIntegration] Geocoded POIs:', geocodedCount);
console.log('[ServiceIntegration] Stats:', stats);
```

### Performance Metrics

Track service call durations:

```typescript
const startTime = Date.now();
const response = await agentHub.fetch(`/api/entity-cache/${type}/${name}`);
const duration = Date.now() - startTime;

console.log(`[ServiceIntegration] Agent hub call: ${duration}ms`);
```

### Error Tracking

```typescript
try {
  // Service call
} catch (error) {
  // Log structured error
  console.error('[ServiceIntegration] Error:', {
    service: 'agent-hub',
    endpoint: `/api/entity-cache/${type}/${name}`,
    error: error.message,
    stack: error.stack,
  });

  // Send to error tracking service (optional)
  // Sentry.captureException(error);
}
```

## Related Files

- Service Fetcher: `apps/web/lib/service-fetcher.ts`
- Entity Cache Proxy: `apps/web/app/api/entity-cache/[type]/[name]/route.ts`
- Agent Hub Route: `apps/agentic/agent-hub/src/app/api/entity-cache/[type]/[name]/route.ts`
- Agent Hub SOP: `apps/agentic/agent-hub/src/app/api/execute-sop/route.ts`
- MCP Hub Travel: `apps/mcp/mcp-hub/src/services/travel-service.ts`

## See Also

- [Entity Cache System](ENTITY_CACHE_SYSTEM.md) - R2 cache architecture
- [Context Maps & POI Management](CONTEXT_MAP_POI.md) - Map visualization
- [Database Operations](../ops/DATABASE.md) - Stats storage
