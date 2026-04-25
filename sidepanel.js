// Fix Leaflet's default icon paths to use bundled assets
if (typeof L !== 'undefined') {
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'vendor/images/marker-icon-2x.png',
    iconUrl: 'vendor/images/marker-icon.png',
    shadowUrl: 'vendor/images/marker-shadow.png',
  });
}

// ─── Helpers ───

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

// Parse the tagged text format returned by video-instant-poi-extraction.
// Format is deterministic:
//   [primary-location]Name|lat|lng[/primary-location]   → location metadata
//   [airport]...[/airport]                               → airport tag
//   - POI Name                                           → a POI
//   - POI Name @ Location                                → POI with location hint
//   Anything else                                        → preamble/prose (skip)
// POI lines always start with "- ". Tags are in [brackets].
// Non-POI, non-tag lines are LLM preamble and are skipped.

function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.includes('youtube.com') || u.hostname === 'youtu.be';
  } catch { return false; }
}

function getYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') return u.searchParams.get('v');
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
  } catch {}
  return null;
}

// ═══════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════

function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${tabId}`));
  if (tabId === 'drawer') loadDrawer();
}

// ═══════════════════════════════════════════════════
// CAPTURE TAB
// ═══════════════════════════════════════════════════

async function loadItems() {
  const result = await chrome.storage.local.get(['capturedItems']);
  const items = result.capturedItems || [];

  const itemCount = document.getElementById('itemCount');
  const itemList = document.getElementById('itemList');
  const extractBtn = document.getElementById('extractBtn');
  const extractLabel = document.getElementById('extractLabel');

  itemCount.textContent = `${items.length}`;

  if (items.length > 0) {
    extractBtn.classList.remove('hidden');
    extractLabel.textContent = `Extract (${items.length})`;
  } else {
    extractBtn.classList.add('hidden');
  }

  if (items.length === 0) {
    itemList.innerHTML = `
      <div class="empty-state">
        <p>No pages captured yet</p>
        <small>Click "Capture Current Page" to start</small>
      </div>`;
    return;
  }

  itemList.innerHTML = items.map((item, index) => {
    const date = new Date(item.capturedAt);
    const formattedDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `
    <div class="item-card">
      ${item.thumbnail ? `<img class="item-thumb" src="${item.thumbnail}" alt="${escapeHtml(item.title || 'Untitled')}">` : `<div class="item-num">${index + 1}</div>`}
      <div class="item-body">
        <div class="item-title">${escapeHtml(item.title || 'Untitled')}</div>
        <a class="item-url" href="${escapeHtml(item.url)}" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a>
        ${item.description ? `<div class="item-description">${escapeHtml(item.description)}</div>` : ''}
        <div class="item-date">${formattedDate}</div>
      </div>
      <button class="delete-btn" data-index="${index}" title="Remove">&times;</button>
    </div>`;
  }).join('');

  document.querySelectorAll('.item-url').forEach(el => {
    el.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url: el.href }); });
  });
  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => { await deleteItem(parseInt(e.target.dataset.index)); });
  });
}

// ─── Page capture ───

async function extractYouTubeData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let description = '';
        try { const d = ytInitialPlayerResponse?.videoDetails?.shortDescription; if (d) description = d; } catch {}
        if (!description) {
          try { const d = ytInitialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[1]?.videoSecondaryInfoRenderer?.attributedDescriptionBodyText?.content; if (d) description = d; } catch {}
        }
        if (!description) {
          for (const sel of ['#attributed-snippet-text','#description-inner','ytd-expandable-video-description-body-renderer','#description-inline-expander']) {
            const el = document.querySelector(sel);
            if (el?.textContent?.trim()) { description = el.textContent.trim(); break; }
          }
        }
        if (!description) { const m = document.querySelector('meta[property="og:description"]'); description = m?.getAttribute('content') || ''; }
        return { description };
      }
    });
    return results?.[0]?.result || { description: '' };
  } catch { return { description: '' }; }
}

async function extractPageData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let thumbnail = '';
        const og = document.querySelector('meta[property="og:image"]'); if (og) thumbnail = og.getAttribute('content') || '';
        if (!thumbnail) { const tw = document.querySelector('meta[name="twitter:image"], meta[property="twitter:image"]'); thumbnail = tw?.getAttribute('content') || ''; }
        let description = '';
        const ogd = document.querySelector('meta[property="og:description"]'); if (ogd) description = ogd.getAttribute('content') || '';
        if (!description) { const md = document.querySelector('meta[name="description"]'); description = md?.getAttribute('content') || ''; }
        return { thumbnail, description };
      }
    });
    return results?.[0]?.result || { thumbnail: '', description: '' };
  } catch { return { thumbnail: '', description: '' }; }
}

async function captureCurrentPage() {
  const btn = document.getElementById('captureBtn');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      showError(btn, 'Cannot capture'); return;
    }

    let thumbnail = '', description = '';
    const ytId = getYouTubeVideoId(tab.url);
    if (ytId) {
      thumbnail = `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`;
      description = (await extractYouTubeData(tab.id)).description;
    } else {
      const data = await extractPageData(tab.id);
      thumbnail = data.thumbnail; description = data.description;
    }

    const item = { id: crypto.randomUUID(), url: tab.url, title: tab.title || 'Untitled', description, thumbnail, capturedAt: Date.now() };
    const response = await chrome.runtime.sendMessage({ action: 'captureItem', item });

    if (response?.success) {
      const orig = btn.innerHTML;
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Captured!`;
      btn.classList.add('captured');
      setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('captured'); }, 1200);
      await loadItems();
    } else { showError(btn, 'Failed'); }
  } catch { showError(btn, 'Failed'); }
}

function showError(btn, msg) {
  const orig = btn.innerHTML; btn.textContent = msg; btn.classList.add('error');
  setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('error'); }, 1200);
}

async function deleteItem(index) {
  const result = await chrome.storage.local.get(['capturedItems']);
  const items = result.capturedItems || [];
  items.splice(index, 1);
  await chrome.storage.local.set({ capturedItems: items });
  await loadItems();
}

async function clearAllItems() {
  if (!confirm('Clear all captured items?')) return;
  await chrome.storage.local.set({ capturedItems: [] });
  await loadItems();
}

// ─── Export ───

async function exportToCSV() {
  const { capturedItems } = await chrome.storage.local.get('capturedItems');
  const items = capturedItems || [];
  if (!items.length) { alert('No items'); return; }
  const rows = [['Title','URL','Description','Captured At'],
    ...items.map(i => [`"${(i.title||'').replace(/"/g,'""')}"`, i.url, `"${(i.description||'').replace(/"/g,'""')}"`, new Date(i.capturedAt).toISOString()])];
  downloadFile(rows.map(r=>r.join(',')).join('\n'), 'text/csv', `contextforce-${new Date().toISOString().split('T')[0]}.csv`);
}

async function exportToJSON() {
  const { capturedItems } = await chrome.storage.local.get('capturedItems');
  if (!(capturedItems||[]).length) { alert('No items'); return; }
  downloadFile(JSON.stringify(capturedItems, null, 2), 'application/json', `contextforce-${new Date().toISOString().split('T')[0]}.json`);
}

function downloadFile(content, type, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

// ═══════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = settings || {};
  document.getElementById('agentHubInput').value = s.agentHubUrl || 'http://localhost:51957';
  document.getElementById('mcpHubInput').value = s.mcpHubUrl || 'http://localhost:8787';
  document.getElementById('useCacheToggle').checked = s.useCache !== false;
}

async function saveSettings() {
  const agentHubUrl = document.getElementById('agentHubInput').value.trim().replace(/\/$/, '');
  const mcpHubUrl = document.getElementById('mcpHubInput').value.trim().replace(/\/$/, '');
  const useCache = document.getElementById('useCacheToggle').checked;
  await chrome.storage.local.set({ settings: { agentHubUrl, mcpHubUrl, useCache } });
  const btn = document.getElementById('saveSettingsBtn');
  btn.textContent = 'Saved'; setTimeout(() => { btn.textContent = 'Save'; }, 1000);
}

async function isCacheEnabled() {
  const { settings } = await chrome.storage.local.get('settings');
  return (settings || {}).useCache !== false;
}

function toggleSettings() { document.getElementById('settingsPanel').classList.toggle('hidden'); }

// ═══════════════════════════════════════════════════
// RESULTS TAB — EXTRACTION
// ═══════════════════════════════════════════════════

let totalPois = 0;
const sectionData = {}; // index → { deduped, cached, videoCtx } for view toggling

// ─── Cache helpers ───

async function getCache() {
  const { extractionCache } = await chrome.storage.local.get('extractionCache');
  return extractionCache || {};
}

async function setCacheEntry(key, data) {
  const cache = await getCache();
  cache[key] = { ...data, cachedAt: Date.now() };
  await chrome.storage.local.set({ extractionCache: cache });
}

async function getCacheEntry(key) {
  const cache = await getCache();
  return cache[key] || null;
}

// Build cache key matching web app's experience-cache.ts format:
//   experiences/youtube_{videoId}__{mode}.json
//   experiences/tiktok_{videoId}__{mode}.json
//   experiences/entity_general_{compactName}.json
function buildCacheKey(url, mode) {
  const modeChar = mode === 'deep' ? 'd' : mode === 'fast' ? 'f' : 'i';
  try {
    const u = new URL(url);
    const host = u.hostname;
    const path = u.pathname;

    // YouTube
    const ytId = getYouTubeVideoId(url);
    if (ytId) return `experiences/youtube_${ytId}__${modeChar}.json`;

    // TikTok
    if (host.includes('tiktok.com')) {
      const tiktokId = path.split('/video/')[1]?.split(/[?/]/)[0];
      if (tiktokId) return `experiences/tiktok_${tiktokId}__d.json`;
    }

    // Instagram
    if (host.includes('instagram.com')) {
      const shortcode = path.split('/p/')[1]?.split('/')[0] || path.split('/reel/')[1]?.split('/')[0];
      if (shortcode) return `experiences/instagram_${shortcode}__${modeChar}.json`;
    }

    // Generic URL → entity key
    const compactName = (host + path).replace(/[^a-zA-Z0-9]/g, '').slice(0, 60).toLowerCase();
    return `experiences/entity_general_${compactName}.json`;
  } catch {
    return `experiences/entity_general_${url.replace(/[^a-zA-Z0-9]/g, '').slice(0, 60).toLowerCase()}.json`;
  }
}

// Detect input type and select SOP (aligned with agent-hub SOP registry)
function detectSop(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const path = u.pathname.toLowerCase();

    // YouTube — use content-shape-dispatcher for rich NDJSON output
    if (host.includes('youtube.com') || host === 'youtu.be') {
      return { type: 'youtube', sopId: 'content-shape-dispatcher', mode: 'instant', fallbackSopId: 'video-deep-poi-extraction' };
    }
    // TikTok
    if (host.includes('tiktok.com')) {
      return { type: 'tiktok', sopId: 'tiktok-video-poi-extraction', mode: 'deep', fallbackSopId: null };
    }
    // Instagram
    if (host.includes('instagram.com')) {
      return { type: 'instagram', sopId: 'video-instant-poi-extraction', mode: 'instant', fallbackSopId: 'video-deep-poi-extraction' };
    }
    // Image URLs
    if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(path)) {
      return { type: 'image', sopId: 'image-spatial-intelligence', mode: 'deep', fallbackSopId: null };
    }
  } catch {}
  // Generic URL / entity
  return { type: 'generic', sopId: 'entity-poi-extraction', mode: 'fast', fallbackSopId: null };
}

async function startExtraction() {
  const { capturedItems, settings } = await chrome.storage.local.get(['capturedItems', 'settings']);
  const items = capturedItems || [];
  const s = settings || {};

  if (!s.agentHubUrl || !s.mcpHubUrl) {
    alert('Set Agent Hub and MCP Hub URLs in settings first.');
    toggleSettings(); return;
  }
  if (!items.length) return;

  // Switch to results tab and start extraction
  switchTab('results');
  const container = document.getElementById('resultsContent');
  container.innerHTML = '';
  // Clear active maps from previous extractions
  Object.keys(activeMaps).forEach(k => delete activeMaps[k]);
  Object.keys(sectionData).forEach(k => delete sectionData[k]);
  totalPois = 0;

  // Reset global view toggle
  const globalToggle = document.getElementById('globalViewToggle');
  const globalBtn = document.getElementById('globalViewBtn');
  globalToggle.style.display = 'none';
  globalBtn.dataset.view = 'experiences';
  globalBtn.textContent = 'POIs';

  // Wire global view toggle (only once)
  if (!globalBtn._wired) {
    globalBtn._wired = true;
    globalBtn.addEventListener('click', () => {
      const isPois = globalBtn.dataset.view === 'pois';
      globalBtn.dataset.view = isPois ? 'experiences' : 'pois';
      globalBtn.textContent = isPois ? 'POIs' : 'Experiences';
      // Re-render all sections
      for (const idx of Object.keys(sectionData)) {
        renderSectionView(idx, globalBtn.dataset.view);
      }
    });
  }

  // Build sections
  container.innerHTML = items.map((item, i) => buildSectionHTML(item, i)).join('');

  // Extract all in parallel
  const promises = items.map((item, i) => extractUrl(s.agentHubUrl, s.mcpHubUrl, item, i));
  await Promise.allSettled(promises);
}

function buildSectionHTML(item, index) {
  const thumb = item.thumbnail
    ? `<img class="url-section-thumb" src="${escapeHtml(item.thumbnail)}" alt="">`
    : `<div class="url-section-thumb-placeholder">↗</div>`;

  return `
  <div class="url-section" id="url-section-${index}">
    <div class="url-section-header">
      ${thumb}
      <div class="url-section-info">
        <div class="url-section-title">${escapeHtml(item.title || item.url)}</div>
        <a class="url-section-link" href="${escapeHtml(item.url)}" target="_blank">${escapeHtml(item.url)}</a>
        <div class="url-section-status" id="url-status-${index}">
          <div class="spinner"></div> <span>Extracting…</span>
        </div>
      </div>
    </div>
    <div id="url-map-${index}" class="mini-map" style="display:none;"></div>
    <div id="url-pois-${index}">
      <div class="skeleton-card"><div class="skeleton-avatar"></div><div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div>
      <div class="skeleton-card"><div class="skeleton-avatar"></div><div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div>
    </div>
  </div>`;
}

async function extractUrl(agentHubUrl, mcpHubUrl, item, index) {
  const statusEl = document.getElementById(`url-status-${index}`);
  const poisEl = document.getElementById(`url-pois-${index}`);
  poisEl.innerHTML = '';

  const sopInfo = detectSop(item.url);
  const cacheKey = buildCacheKey(item.url, sopInfo.mode);

  try {
    const useCache = await isCacheEnabled();

    // ── Layer 1: Local cache (chrome.storage.local) — instant, no network ──
    if (useCache) {
      const cached = await getCacheEntry(cacheKey);
      if (cached && cached.pois) {
        await renderFromCache(poisEl, cached, mcpHubUrl, index);
        return;
      }

      // ── Layer 2: R2 cache via /api/poi-cache/ — skip LLM if another client already extracted ──
      statusEl.innerHTML = `<div class="spinner"></div> <span>Checking cache…</span>`;
      const r2Data = await checkR2Cache(agentHubUrl, item.url, sopInfo);
      if (r2Data) {
        statusEl.innerHTML = `<div class="spinner"></div> <span>R2 cache hit — geocoding…</span>`;
        await processR2CacheHit(poisEl, r2Data, mcpHubUrl, index, cacheKey);
        return;
      }
    }

    // ── Layer 3: Fresh extraction via agent-hub ──
    statusEl.innerHTML = `<div class="spinner"></div> <span>Extracting…</span>`;
    const inputs = { videoUrl: item.url, url: item.url };
    const videoMeta = {};
    if (item.title) videoMeta.title = item.title;
    if (item.thumbnail) videoMeta.thumbnailUrl = item.thumbnail;

    // Fetch from agent-hub
    const res = await fetchAgentHub(agentHubUrl, sopInfo.sopId, inputs, sopInfo.mode, videoMeta);

    // content-shape-dispatcher → NDJSON streaming pipeline
    if (sopInfo.sopId === 'content-shape-dispatcher' && res.body) {
      await processShapeDispatcher(res, mcpHubUrl, index, cacheKey, videoMeta, item);
      return;
    }

    // Other instant-mode SOPs → text streaming
    if (sopInfo.mode === 'instant' && res.body) {
      await processStreamedResponse(res, mcpHubUrl, index, cacheKey, sopInfo, agentHubUrl, inputs, videoMeta);
      return;
    }

    const text = await res.text();

    // Check if instant mode failed (no transcript) — fallback to deep
    if (sopInfo.fallbackSopId && sopInfo.mode === 'instant' && (text.includes('Failed to fetch transcript') || res.status >= 400)) {
      statusEl.innerHTML = `<div class="spinner"></div> <span>Retrying in deep mode…</span>`;
      const deepRes = await fetchAgentHub(agentHubUrl, sopInfo.fallbackSopId, inputs, 'deep', videoMeta);
      const deepText = await deepRes.text();
      await processResponse(deepText, mcpHubUrl, index, cacheKey, videoMeta);
      return;
    }

    await processResponse(text, mcpHubUrl, index, cacheKey, videoMeta);
  } catch (err) {
    statusEl.innerHTML = `<span class="fail">Failed</span>`;
    poisEl.innerHTML = `<div class="error-state">${escapeHtml(err.message)}</div>`;
    throw err;
  }
}

async function fetchAgentHub(agentHubUrl, sopId, inputs, mode, videoMeta) {
  const body = {
    sopId,
    inputs,
    extractionMode: mode,
  };
  if (videoMeta && Object.keys(videoMeta).length > 0) {
    body.videoMeta = videoMeta;
  }

  const res = await fetch(`${agentHubUrl}/api/execute-sop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return res;
}

// ── R2 cache check via agent-hub's /api/poi-cache/ endpoint ──
async function checkR2Cache(agentHubUrl, url, sopInfo) {
  const ytId = getYouTubeVideoId(url);
  try {
    let cacheUrl;
    if (ytId && (sopInfo.type === 'youtube')) {
      // YouTube: /api/poi-cache/youtube/{videoId}?mode=fast
      const mode = sopInfo.mode === 'deep' ? 'deep' : 'fast';
      cacheUrl = `${agentHubUrl}/api/poi-cache/youtube/${ytId}?mode=${mode}`;
    } else if (sopInfo.type === 'tiktok') {
      // TikTok: extract video ID from URL
      const tiktokId = url.split('/video/')[1]?.split(/[?/]/)[0];
      if (tiktokId) cacheUrl = `${agentHubUrl}/api/poi-cache/tiktok/${tiktokId}?mode=deep`;
    } else if (sopInfo.type === 'generic') {
      // Entity/generic: use domain-based key
      const u = new URL(url);
      const compactName = u.hostname.replace(/\./g, '');
      cacheUrl = `${agentHubUrl}/api/poi-cache/entity/general/${compactName}`;
    }

    if (!cacheUrl) return null;

    const res = await fetch(cacheUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;

    const data = await res.json();
    // Must have pois array to be valid
    if (!data.pois || !Array.isArray(data.pois) || data.pois.length === 0) return null;
    return data;
  } catch {
    return null; // Network error, timeout, etc — proceed to extraction
  }
}

// Process an R2 cache hit — re-geocode POI names for fresh coordinates
async function processR2CacheHit(poisEl, data, mcpHubUrl, index, cacheKey) {
  const statusEl = document.getElementById(`url-status-${index}`);

  const rawPois = data.pois || [];
  let primaryLat = data.primaryLocationCoords?.lat ?? null;
  let primaryLng = data.primaryLocationCoords?.lng ?? null;

  // Build source lookup
  const sources = data.sources || [];
  const sourceMap = {};
  sources.forEach((s, i) => { sourceMap[`#${i + 1}`] = s; });

  // Render sources bar if present
  if (sources.length > 0) {
    appendSourcesBar(poisEl, sources);
  }

  // Build POI objects — geocode any that lack coordinates
  const pois = rawPois.map((p, i) => ({
    id: `poi-${i}`,
    query: p.name,
    status: p.coordinates ? 'success' : 'pending',
    name: p.name,
    address: p.location || p.address,
    coordinates: p.coordinates || null,
    placeId: p.placeId || p.place_id || null,
    description: p.description,
    imageUrl: p.imageUrl,
    sourceId: p.sourceId || null,
    sources: resolveSourceRefs(p.sourceId, sourceMap),
    timelineSeconds: p.timelineSeconds || null,
  }));

  // Geocode POIs without coordinates
  const toGeocode = pois.filter(p => p.status === 'pending');
  if (toGeocode.length > 0) {
    statusEl.innerHTML = `<div class="spinner"></div> <span>Geocoding ${toGeocode.length} POIs…</span>`;
    const BATCH = 4;
    for (let i = 0; i < toGeocode.length; i += BATCH) {
      const batch = toGeocode.slice(i, i + BATCH);
      await Promise.all(batch.map(poi => geocodePoi(poi, mcpHubUrl, primaryLat, primaryLng)));
    }
  }

  // Deduplicate
  const seen = new Set();
  const deduped = pois.filter(p => {
    if (p.status !== 'success' || !p.placeId) return true;
    if (seen.has(p.placeId)) return false;
    seen.add(p.placeId);
    return true;
  });

  // Write full data to local cache (same structure as R2)
  if (cacheKey) {
    setCacheEntry(cacheKey, {
      pois: deduped.map(p => ({
        name: p.name || p.query,
        location: p.address,
        placeId: p.placeId,
        coordinates: p.coordinates,
        description: p.description,
        imageUrl: p.imageUrl,
        sourceId: p.sourceId,
        timelineSeconds: p.timelineSeconds,
      })),
      sources: sources,
      primaryLocation: data.primaryLocation || null,
      primaryLocationCoords: primaryLat != null ? { lat: primaryLat, lng: primaryLng } : null,
      _videoMeta: data._videoMeta || null,
      _instant: data._instant || false,
    });
  }

  // Render
  let rendered = 0;
  const mapPois = [];
  for (const poi of deduped) {
    rendered++; totalPois++;
    appendPoiCard(poisEl, poi);
    if (poi.status === 'success' && poi.coordinates) {
      mapPois.push({ name: poi.name, lat: poi.coordinates.lat, lng: poi.coordinates.lng });
    }
  }
  if (mapPois.length > 0) initMap(index, mapPois);

  statusEl.innerHTML = `<span class="done">${rendered} POIs (R2 cache)</span>`;
}

// Stream instant mode response — parse POI names line by line and geocode as they arrive
async function processStreamedResponse(res, mcpHubUrl, index, cacheKey, sopInfo, agentHubUrl, inputs, videoMeta) {
  const poisEl = document.getElementById(`url-pois-${index}`);
  const statusEl = document.getElementById(`url-status-${index}`);
  poisEl.innerHTML = '';

  let primaryLat = null, primaryLng = null;
  const pois = [];
  let buffer = '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse tagged metadata
        const pl = trimmed.match(/^\[primary-location\](.*?)\[\/primary-location\]$/);
        if (pl) {
          const parts = pl[1].split('|');
          if (parts[1]) primaryLat = parseFloat(parts[1]);
          if (parts[2]) primaryLng = parseFloat(parts[2]);
          continue;
        }
        if (trimmed.startsWith('[')) continue;

        // Extract POI name from bullet lines
        const bulletMatch = trimmed.match(/^[-•]\s+(.+)/);
        if (!bulletMatch) continue;
        const cleaned = bulletMatch[1].trim();
        if (!cleaned) continue;

        const poi = { id: `poi-${pois.length}`, query: cleaned, status: 'pending' };
        pois.push(poi);

        // Geocode this POI immediately (non-blocking)
        statusEl.innerHTML = `<div class="spinner"></div> <span>Geocoding ${pois.length} POIs…</span>`;
        geocodePoi(poi, mcpHubUrl, primaryLat, primaryLng).then(() => {
          appendPoiCard(poisEl, poi);
          totalPois++;
          // Update map when coordinates arrive
          if (poi.status === 'success' && poi.coordinates) {
            updateMapWithPoi(index, poi.name, poi.coordinates.lat, poi.coordinates.lng);
          }
        });
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      const bulletMatch = trimmed.match(/^[-•]\s+(.+)/);
      if (bulletMatch) {
        const cleaned = bulletMatch[1].trim();
        if (cleaned) {
          const poi = { id: `poi-${pois.length}`, query: cleaned, status: 'pending' };
          pois.push(poi);
          await geocodePoi(poi, mcpHubUrl, primaryLat, primaryLng);
          appendPoiCard(poisEl, poi);
          totalPois++;
          if (poi.status === 'success' && poi.coordinates) {
            updateMapWithPoi(index, poi.name, poi.coordinates.lat, poi.coordinates.lng);
          }
        }
      }
    }
  } catch (err) {
    // Check if error is a transcript failure → fallback to deep mode
    if (sopInfo.fallbackSopId && err.message?.includes('transcript')) {
      statusEl.innerHTML = `<div class="spinner"></div> <span>Retrying in deep mode…</span>`;
      poisEl.innerHTML = '';
      const deepRes = await fetchAgentHub(agentHubUrl, sopInfo.fallbackSopId, inputs, 'deep', videoMeta);
      const deepText = await deepRes.text();
      await processResponse(deepText, mcpHubUrl, index, cacheKey, videoMeta);
      return;
    }
    throw err;
  }

  // Wait for all in-flight geocoding to finish
  await new Promise(resolve => {
    const check = () => {
      if (pois.every(p => p.status !== 'pending')) return resolve();
      setTimeout(check, 100);
    };
    check();
  });

  // Deduplicate
  const seen = new Set();
  const deduped = pois.filter(p => {
    if (p.status !== 'success' || !p.placeId) return true;
    if (seen.has(p.placeId)) return false;
    seen.add(p.placeId);
    return true;
  });

  // Re-render deduped list (replace streamed cards with deduped version)
  poisEl.innerHTML = '';
  const mapPois = [];
  for (const poi of deduped) {
    appendPoiCard(poisEl, poi);
    if (poi.status === 'success' && poi.coordinates) {
      mapPois.push({ name: poi.name, lat: poi.coordinates.lat, lng: poi.coordinates.lng });
    }
  }
  if (mapPois.length > 0) initMap(index, mapPois);

  // Cache full data (instant mode — POI names only, re-geocode on hit)
  if (cacheKey) {
    setCacheEntry(cacheKey, {
      pois: deduped.map(p => ({
        name: p.name || p.query,
        location: p.address,
        placeId: p.placeId,
        coordinates: p.coordinates,
        description: p.description,
        imageUrl: p.imageUrl,
      })),
      sources: [],
      primaryLocation: primaryLat != null ? `${primaryLat},${primaryLng}` : null,
      primaryLocationCoords: primaryLat != null ? { lat: primaryLat, lng: primaryLng } : null,
      _videoMeta: videoMeta || null,
      _instant: true,
    });
  }

  const label = `${deduped.length} POI${deduped.length !== 1 ? 's' : ''} found`;
  statusEl.innerHTML = `<span class="done">${label}</span>`;
}

// Geocode a single POI (mutates poi in place)
async function geocodePoi(poi, mcpHubUrl, primaryLat, primaryLng) {
  const params = new URLSearchParams({ name: poi.query, allowMapResultImage: 'true' });
  if (primaryLat != null) { params.set('lat', primaryLat); params.set('lng', primaryLng); }
  try {
    const r = await fetch(`${mcpHubUrl}/api/place-search?${params}`);
    if (!r.ok) { poi.status = 'not-found'; return; }
    const d = await r.json();
    if (d.error || !d.place_id) { poi.status = 'not-found'; return; }
    poi.status = 'success';
    poi.name = d.name || poi.query;
    poi.placeId = d.place_id;
    poi.coordinates = d.coordinates ? { lat: d.coordinates.latitude, lng: d.coordinates.longitude } : null;
    poi.address = d.address;
    poi.rating = d.rating;
    poi.reviewCount = d.reviewCount;
    poi.imageUrl = d.image || d.googleImage || poi.imageUrl;
    poi.description = d.description;
    poi.googleMapsUrl = d.googleMapsUrl;
  } catch { poi.status = 'not-found'; }
}

// Add a single marker to an existing map, or create one if needed
const activeMaps = {};
function updateMapWithPoi(index, name, lat, lng) {
  const el = document.getElementById(`url-map-${index}`);
  if (!el) return;

  // If the DOM was cleared (innerHTML=''), invalidate the old map
  if (activeMaps[index] && !activeMaps[index].getContainer()) {
    delete activeMaps[index];
  }

  if (!activeMaps[index]) {
    el.style.display = 'block';
    activeMaps[index] = L.map(el, { scrollWheelZoom: false, zoomControl: false, attributionControl: false })
      .setView([lat, lng], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(activeMaps[index]);
  }

  // Count existing markers to assign numbered pin
  const existingCount = [];
  activeMaps[index].eachLayer(l => { if (l instanceof L.Marker) existingCount.push(l); });
  const num = existingCount.length + 1;
  const icon = L.divIcon({
    className: 'custom-pin',
    html: `<div class="pin-body">${num}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
  L.marker([lat, lng], { icon }).addTo(activeMaps[index]).bindTooltip(name, {
    className: 'pin-label',
    direction: 'top',
    offset: [0, -16],
  });

  // Fit bounds to all markers
  const map = activeMaps[index];
  const markers = [];
  map.eachLayer(l => { if (l instanceof L.Marker) markers.push(l.getLatLng()); });
  if (markers.length > 1) map.fitBounds(L.latLngBounds(markers), { padding: [14, 14] });
}

// ── Rate limiter for concurrent geocoding ──
function createLimiter(max) {
  let running = 0;
  const queue = [];
  return function limiter(fn) {
    if (running >= max) return new Promise(r => queue.push(r)).then(() => limiter(fn));
    running++;
    return fn().finally(() => { running--; if (queue.length) queue.shift()(); });
  };
}

// ── Normalize POI name for deduplication ──
function normalizePoiName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
}

// ═══════════════════════════════════════════════════
// CONTENT-SHAPE-DISPATCHER — NDJSON streaming pipeline
// ═══════════════════════════════════════════════════

async function processShapeDispatcher(res, mcpHubUrl, index, cacheKey, videoMeta, item) {
  const poisEl = document.getElementById(`url-pois-${index}`);
  const statusEl = document.getElementById(`url-status-${index}`);
  // Show loading state while streaming
  poisEl.innerHTML = `<div class="skeleton-card"><div class="skeleton-avatar"></div><div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div></div>`;

  const result = {
    pois: [],
    sources: [],
    tips: [],
    microExperiences: [],
    items: [],
    _videoMeta: videoMeta || null,
    _instant: true,
  };

  let currentMeId = null;
  let primaryLocation = null;
  let primaryLat = null, primaryLng = null;
  const seenNames = new Map(); // normalized name → pois[] index

  const limiter = createLimiter(5);
  const geocodePromises = [];

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }

        switch (event.type) {
          case 'shape':
            result.shape = event.shape || 'extraction';
            statusEl.innerHTML = `<div class="spinner"></div> <span>Shape: ${result.shape} — extracting…</span>`;
            break;

          case 'video-title':
            result.videoTitle = event.text || '';
            break;

          case 'article-title':
            result.articleTitle = event.text || '';
            break;

          case 'video-summary':
            result.videoSummary = event.text || '';
            break;

          case 'primary-location':
            if (event.city) { primaryLocation = event.city; result.primaryLocation = event.city; }
            if (typeof event.lat === 'number' && typeof event.lng === 'number') {
              primaryLat = event.lat; primaryLng = event.lng;
              result.primaryLocationCoords = { lat: event.lat, lng: event.lng };
            }
            break;

          case 'video-meta':
            if (event.data) result._videoMeta = { ...result._videoMeta, ...event.data };
            break;

          case 'me-start':
            if (typeof event.id !== 'number') break;
            const me = {
              id: event.id,
              title: event.title || `Part ${event.id}`,
              timeOfDay: event.timeOfDay || null,
              duration: event.duration || null,
              narrative: event.narrative || null,
              stopRefs: [],
            };
            result.microExperiences.push(me);
            currentMeId = event.id;
            // Render ME header immediately
            appendMeHeader(poisEl, me, result.microExperiences.length - 1);
            break;

          case 'listicle-meta':
            result.listicleMeta = { category: event.category || null, rankingBasis: event.rankingBasis || null };
            break;

          case 'stop':
          case 'item':
          case 'poi': {
            if (!event.name) break;

            // Upsert POI (deduplicate by normalized name)
            const norm = normalizePoiName(event.name);
            let poiIdx = seenNames.get(norm);
            let poi;
            if (poiIdx !== undefined) {
              poi = result.pois[poiIdx];
            } else {
              poiIdx = result.pois.length;
              poi = {
                id: `poi-${poiIdx}`,
                query: event.name,
                name: event.name,
                status: 'pending',
                mentions: [],
                highlight: event.highlight || null,
                category: event.category || null,
                neighborhood: event.neighborhood || null,
              };
              result.pois.push(poi);
              seenNames.set(norm, poiIdx);

              // Fire geocode (rate-limited) — no rendering during streaming
              statusEl.innerHTML = `<div class="spinner"></div> <span>Geocoding ${result.pois.length} POIs…</span>`;
              geocodePromises.push(
                limiter(() => geocodePoi(poi, mcpHubUrl, primaryLat, primaryLng))
              );
            }

            // Attach mention
            if (event.quote || event.videoTimestamp) {
              poi.mentions.push({
                quote: event.quote || null,
                videoTimestamp: event.videoTimestamp || null,
              });
            }

            // Attach to shape container
            if (result.shape === 'listicle') {
              result.items.push({
                poiIndex: poiIdx,
                rank: typeof event.rank === 'number' ? event.rank : result.items.length + 1,
                quote: event.quote || null,
                proTip: event.proTip || null,
                videoTimestamp: event.videoTimestamp || null,
              });
            } else {
              // Attach to current micro-experience
              const meId = event.meId ?? currentMeId;
              const me = result.microExperiences.find(m => m.id === meId);
              if (me) {
                me.stopRefs.push({
                  poiIndex: poiIdx,
                  videoTimestamp: event.videoTimestamp || null,
                  quote: event.quote || null,
                  stayDuration: event.stayDuration || null,
                });
              }
            }
            break;
          }

          case 'tip':
            result.tips.push({
              tip: event.body || event.tip || '',
              title: event.title || null,
              category: event.category || 'General',
              timestamp: event.videoTimestamp || null,
            });
            break;

          case 'done':
            break;
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer.trim());
        if (event.type === 'tip') {
          result.tips.push({
            tip: event.body || event.tip || '',
            title: event.title || null,
            category: event.category || 'General',
            timestamp: event.videoTimestamp || null,
          });
        }
      } catch {}
    }
  } catch (err) {
    // Fallback to deep mode if transcript fails
    if (err.message?.includes('transcript')) {
      statusEl.innerHTML = `<div class="spinner"></div> <span>Fallback to deep mode…</span>`;
      return;
    }
    throw err;
  }

  // Wait for all geocodes to finish
  await Promise.all(geocodePromises);

  // Deduplicate by placeId
  const seen = new Set();
  const deduped = result.pois.filter(p => {
    if (p.status !== 'success' || !p.placeId) return true;
    if (seen.has(p.placeId)) return false;
    seen.add(p.placeId);
    return true;
  });

  // Store for view toggling
  const videoCtx = {
    videoTitle: result.videoTitle || result._videoMeta?.title || (item ? item.title : ''),
    videoUrl: item ? item.url : '',
    videoThumb: item ? item.thumbnail : (result._videoMeta?.thumbnailUrl || null),
  };
  const cached = {
    microExperiences: result.microExperiences,
    tips: result.tips,
    videoTitle: result.videoTitle,
    _videoMeta: result._videoMeta,
    _sourceUrl: item ? item.url : '',
    shape: result.shape,
  };
  sectionData[index] = { deduped, cached, videoCtx };

  // Show global view toggle if we have MEs
  if (result.microExperiences.length > 0) {
    document.getElementById('globalViewToggle').style.display = 'flex';
  }

  // Build mapPois from all deduped POIs
  const mapPois = [];
  for (const p of deduped) {
    if (p.status === 'success' && p.coordinates) {
      mapPois.push({ name: p.name, lat: p.coordinates.lat, lng: p.coordinates.lng });
    }
  }

  // Respect current global view mode
  const globalView = document.getElementById('globalViewBtn')?.dataset.view || 'experiences';
  if (globalView === 'pois') {
    renderSectionView(index, 'pois');
    if (mapPois.length > 0) initMap(index, mapPois);
    return;
  }

  // Render: editorial layout with ME sections + stop cards
  poisEl.innerHTML = '';

  if (result.microExperiences.length > 0) {
    result.microExperiences.forEach((me, meIdx) => {
      const mePois = (me.stopRefs || [])
        .map(ref => ({ ...deduped[ref.poiIndex], _ref: ref }))
        .filter(p => p.name);

      mePois.forEach(p => { totalPois++; });

      const card = buildMeAccordionCard(me, meIdx, mePois, videoCtx);
      poisEl.appendChild(card);
    });
  } else {
    for (const poi of deduped) {
      totalPois++;
    }
    for (const poi of deduped) {
      appendPoiCard(poisEl, poi, videoCtx);
    }
  }

  if (mapPois.length > 0) initMap(index, mapPois);

  // Cache full shape data
  if (cacheKey) {
    setCacheEntry(cacheKey, {
      shape: result.shape || 'extraction',
      videoTitle: result.videoTitle || null,
      videoSummary: result.videoSummary || null,
      primaryLocation: result.primaryLocation || null,
      primaryLocationCoords: result.primaryLocationCoords || null,
      pois: deduped.map(p => ({
        name: p.name, placeId: p.placeId, coordinates: p.coordinates,
        imageUrl: p.imageUrl, address: p.address, rating: p.rating,
        reviewCount: p.reviewCount, category: p.category, neighborhood: p.neighborhood,
        highlight: p.highlight, mentions: p.mentions,
      })),
      sources: result.sources,
      tips: result.tips,
      microExperiences: result.microExperiences.map(({ id, ...me }) => me),
      items: result.items,
      _videoMeta: result._videoMeta,
      _instant: true,
    });
  }

  const meCount = result.microExperiences.length;
  const label = meCount > 0
    ? `${meCount} experience${meCount !== 1 ? 's' : ''}, ${deduped.length} places`
    : `${deduped.length} places`;
  statusEl.innerHTML = `<span class="done">${label}</span>`;
}

// ── Build an accordion card for one micro-experience ──
function buildMeAccordionCard(me, meIdx, mePois, videoCtx) {
  const isFirst = meIdx === 0;
  const card = document.createElement('div');
  card.className = 'me-card' + (isFirst ? ' open' : '');

  const badges = [
    me.timeOfDay ? `<span class="me-badge">${escapeHtml(me.timeOfDay)}</span>` : '',
    me.duration ? `<span class="me-badge">${escapeHtml(me.duration)}</span>` : '',
    `<span class="me-badge">${mePois.length} stop${mePois.length !== 1 ? 's' : ''}</span>`,
  ].filter(Boolean).join('');

  // Toggle header (save button embedded inside the flex row)
  const toggle = document.createElement('button');
  toggle.className = 'me-card-toggle';
  toggle.innerHTML = `
    <div class="me-card-num">${meIdx + 1}</div>
    <div class="me-card-info">
      <div class="me-card-title">${escapeHtml(me.title)}</div>
      <div class="me-card-meta">${badges}</div>
    </div>
    <button class="me-save-btn" type="button" title="Save to drawer">＋</button>
    <div class="me-card-arrow">▾</div>`;

  // Save handler (attached after innerHTML so the button exists)
  const saveBtnEl = toggle.querySelector('.me-save-btn');
  saveBtnEl.addEventListener('click', async (e) => {
    e.stopPropagation();
    const drawerItem = {
      id: crypto.randomUUID(),
      savedAt: Date.now(),
      videoTitle: videoCtx.videoTitle || '',
      videoUrl: videoCtx.videoUrl || '',
      videoThumb: videoCtx.videoThumb || null,
      meTitle: me.title || '',
      meTimeOfDay: me.timeOfDay || null,
      meDuration: me.duration || null,
      meNarrative: me.narrative || null,
      pois: mePois.map((p, pi) => ({
        name: p.name || p.query,
        coordinates: p.coordinates || null,
        imageUrl: p.imageUrl || null,
        rating: p.rating || null,
        address: p.address || p.neighborhood || null,
        quote: (p._ref && p._ref.quote) || null,
        videoTimestamp: (p._ref && p._ref.videoTimestamp) || null,
      })),
    };
    await saveToDrawer(drawerItem);
    saveBtnEl.textContent = '✓';
    saveBtnEl.classList.add('saved');
    setTimeout(() => {
      saveBtnEl.textContent = '＋';
      saveBtnEl.classList.remove('saved');
    }, 1500);
  });

  toggle.addEventListener('click', (e) => {
    // Don't toggle if the save button was clicked
    if (e.target.closest('.me-save-btn')) return;
    card.classList.toggle('open');
  });

  card.appendChild(toggle);

  // Collapsible body
  const body = document.createElement('div');
  body.className = 'me-card-body';

  if (me.narrative) {
    body.innerHTML = `<div class="me-card-narrative">${escapeHtml(me.narrative)}</div>`;
  }

  const stopsContainer = document.createElement('div');
  stopsContainer.className = 'me-stops';

  mePois.forEach((p, i) => {
    const ref = p._ref || {};
    const thumbImg = (p.status === 'success' && p.imageUrl)
      ? `<img src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy">`
      : '';
    const tsBadge = ref.videoTimestamp
      ? `<span class="time">▶ ${escapeHtml(ref.videoTimestamp)}</span>`
      : '';
    const metaParts = [];
    if (p.address || p.neighborhood) metaParts.push(`<span class="pin">📍</span> ${escapeHtml(p.neighborhood || p.address)}`);
    if (p.rating) metaParts.push(`<span class="rating">★ ${p.rating}</span>`);
    const metaHtml = metaParts.length ? `<div class="meta">${metaParts.join('<span class="sep"> · </span>')}</div>` : '';
    const quoteHtml = ref.quote ? `<div class="quote">${escapeHtml(ref.quote)}</div>` : '';

    const stop = document.createElement('div');
    stop.className = 'me-stop';
    stop.innerHTML = `
      <div class="thumb-wrap">
        ${thumbImg}
        <div class="num-badge">${i + 1}</div>
      </div>
      <div class="body">
        <div class="top-line">
          <h4>${escapeHtml(p.name)}</h4>
          ${tsBadge}
        </div>
        ${metaHtml}
        ${quoteHtml}
      </div>`;

    if (p.status === 'success' && p.coordinates) {
      stop.addEventListener('click', () => chrome.tabs.create({ url: `https://www.google.com/maps/search/?api=1&query=${p.coordinates.lat},${p.coordinates.lng}` }));
    } else {
      stop.addEventListener('click', () => chrome.tabs.create({ url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.query || p.name)}` }));
    }

    stopsContainer.appendChild(stop);
  });

  body.appendChild(stopsContainer);
  card.appendChild(body);

  return card;
}

// ── Micro-experience header (used during streaming) ──
function appendMeHeader(container, me, meIdx) {
  const card = document.createElement('div');
  card.className = 'me-card' + (meIdx === 0 ? ' open' : '');

  const toggle = document.createElement('button');
  toggle.className = 'me-card-toggle';
  toggle.innerHTML = `
    <div class="me-card-num">${meIdx + 1}</div>
    <div class="me-card-info">
      <div class="me-card-title">${escapeHtml(me.title)}</div>
      <div class="me-card-meta">
        ${me.timeOfDay ? `<span class="me-badge">${escapeHtml(me.timeOfDay)}</span>` : ''}
        ${me.duration ? `<span class="me-badge">${escapeHtml(me.duration)}</span>` : ''}
      </div>
    </div>
    <div class="me-card-arrow">▾</div>`;

  toggle.addEventListener('click', () => card.classList.toggle('open'));
  card.appendChild(toggle);

  const body = document.createElement('div');
  body.className = 'me-card-body';
  if (me.narrative) body.innerHTML = `<div class="me-card-narrative">${escapeHtml(me.narrative)}</div>`;
  card.appendChild(body);

  container.appendChild(card);
}

// ── Tip card ──
function appendTipCard(container, tip) {
  const el = document.createElement('div');
  el.className = 'tip-card';
  el.innerHTML = `
    <div class="tip-category">${escapeHtml(tip.category || 'General')}</div>
    <div class="tip-body">${escapeHtml(tip.tip)}</div>
    ${tip.timestamp ? `<div class="tip-timestamp">${escapeHtml(tip.timestamp)}</div>` : ''}`;
  container.appendChild(el);
}

// Route response to the correct parser based on format (JSON vs tagged text)
async function processResponse(text, mcpHubUrl, index, cacheKey, videoMeta) {
  // Try parsing as JSON first (deep mode / entity mode returns JSON)
  try {
    const json = JSON.parse(text);
    if (json.pois && Array.isArray(json.pois)) {
      await processJsonResponse(json, mcpHubUrl, index, cacheKey, videoMeta);
      return;
    }
  } catch {}
  // Fall back to tagged text parsing (instant mode returns text/plain)
  await processTaggedText(text, mcpHubUrl, index, cacheKey, videoMeta);
}

// Handle structured JSON response (from deep/entity SOPs)
async function processJsonResponse(data, mcpHubUrl, index, cacheKey, videoMeta) {
  const poisEl = document.getElementById(`url-pois-${index}`);
  const statusEl = document.getElementById(`url-status-${index}`);
  poisEl.innerHTML = '';

  const rawPois = data.pois || [];
  const sources = data.sources || [];
  let primaryLat = data.primaryLocationCoords?.lat ?? null;
  let primaryLng = data.primaryLocationCoords?.lng ?? null;

  // Build source lookup: "#1" → { title, url, type, timestamp }
  const sourceMap = {};
  sources.forEach((s, i) => { sourceMap[`#${i + 1}`] = s; });

  // Build POI objects from JSON
  const pois = rawPois.map((p, i) => ({
    id: `poi-${i}`,
    query: p.name,
    status: p.coordinates ? 'success' : 'pending',
    name: p.name,
    address: p.location || p.address,
    coordinates: p.coordinates || null,
    placeId: p.placeId || p.place_id || null,
    description: p.description,
    imageUrl: p.imageUrl,
    sourceId: p.sourceId || null,
    sources: resolveSourceRefs(p.sourceId, sourceMap),
    timelineSeconds: p.timelineSeconds || null,
  }));

  // Geocode POIs that don't have coordinates yet
  const toGeocode = pois.filter(p => p.status === 'pending');
  if (toGeocode.length > 0) {
    statusEl.innerHTML = `<div class="spinner"></div> <span>Geocoding ${toGeocode.length} POIs…</span>`;
    const BATCH = 4;
    for (let i = 0; i < toGeocode.length; i += BATCH) {
      const batch = toGeocode.slice(i, i + BATCH);
      await Promise.all(batch.map(async (poi) => {
        const params = new URLSearchParams({ name: poi.query, allowMapResultImage: 'true' });
        if (primaryLat != null) { params.set('lat', primaryLat); params.set('lng', primaryLng); }
        try {
          const r = await fetch(`${mcpHubUrl}/api/place-search?${params}`);
          if (!r.ok) { poi.status = 'not-found'; return; }
          const d = await r.json();
          if (d.error || !d.place_id) { poi.status = 'not-found'; return; }
          poi.status = 'success';
          poi.name = d.name || poi.query;
          poi.placeId = d.place_id;
          poi.coordinates = d.coordinates ? { lat: d.coordinates.latitude, lng: d.coordinates.longitude } : null;
          poi.address = d.address;
          poi.rating = d.rating;
          poi.reviewCount = d.reviewCount;
          poi.imageUrl = d.image || d.googleImage || poi.imageUrl;
          poi.description = d.description;
          poi.googleMapsUrl = d.googleMapsUrl;
        } catch { poi.status = 'not-found'; }
      }));
    }
  }

  // Deduplicate by placeId
  const seen = new Set();
  const deduped = pois.filter(p => {
    if (p.status !== 'success' || !p.placeId) return true;
    if (seen.has(p.placeId)) return false;
    seen.add(p.placeId);
    return true;
  });

  // Cache full data (deep/entity mode — includes coordinates, return as-is on hit)
  if (cacheKey) {
    setCacheEntry(cacheKey, {
      pois: deduped.map(p => ({
        name: p.name || p.query,
        location: p.address,
        placeId: p.placeId,
        coordinates: p.coordinates,
        description: p.description,
        imageUrl: p.imageUrl,
        sourceId: p.sourceId,
        timelineSeconds: p.timelineSeconds,
      })),
      sources: sources,
      primaryLocation: data.primaryLocation || null,
      primaryLocationCoords: primaryLat != null ? { lat: primaryLat, lng: primaryLng } : null,
      _videoMeta: data._videoMeta || videoMeta || null,
      _instant: false,
    });
  }

  // Render sources bar if present
  if (sources.length > 0) {
    appendSourcesBar(poisEl, sources);
  }

  // Render
  let rendered = 0;
  const mapPois = [];
  for (const poi of deduped) {
    rendered++; totalPois++;
    appendPoiCard(poisEl, poi);
    if (poi.status === 'success' && poi.coordinates) {
      mapPois.push({ name: poi.name, lat: poi.coordinates.lat, lng: poi.coordinates.lng });
    }
  }
  if (mapPois.length > 0) initMap(index, mapPois);

  const label = `${rendered} POI${rendered !== 1 ? 's' : ''} found`;
  statusEl.innerHTML = `<span class="done">${label}</span>`;
}

// Resolve sourceId references like "#1, #3" into source objects
function resolveSourceRefs(sourceId, sourceMap) {
  if (!sourceId) return [];
  const refs = sourceId.split(',').map(s => s.trim());
  return refs.map(r => sourceMap[r]).filter(Boolean);
}

async function processTaggedText(text, mcpHubUrl, index, cacheKey, videoMeta) {
  const poisEl = document.getElementById(`url-pois-${index}`);
  const statusEl = document.getElementById(`url-status-${index}`);
  poisEl.innerHTML = '';

  // ── Step 1: Fetch (already done — we have the full text) ──

  // ── Step 2: Parse tagged text → POI objects with IDs, status 'pending' ──
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let primaryLat = null, primaryLng = null;
  const pois = [];

  for (const line of lines) {
    // Parse tagged metadata lines
    const pl = line.match(/^\[primary-location\](.*?)\[\/primary-location\]$/);
    if (pl) {
      const parts = pl[1].split('|');
      if (parts[1]) primaryLat = parseFloat(parts[1]);
      if (parts[2]) primaryLng = parseFloat(parts[2]);
      continue;
    }
    // Skip other tag lines (e.g. [airport]...)
    if (line.startsWith('[')) continue;

    // Only lines starting with "- " are POI names — everything else is LLM preamble
    const bulletMatch = line.match(/^[-•]\s+(.+)/);
    if (!bulletMatch) continue;

    const cleaned = bulletMatch[1].trim();
    if (!cleaned) continue;
    pois.push({ id: `poi-${pois.length}`, query: cleaned, status: 'pending' });
  }

  statusEl.innerHTML = `<div class="spinner"></div> <span>Geocoding ${pois.length} POIs…</span>`;

  // ── Step 3: Geocode — parallel batches via /api/place-search ──
  const BATCH = 4;
  for (let i = 0; i < pois.length; i += BATCH) {
    const batch = pois.slice(i, i + BATCH);
    await Promise.all(batch.map(async (poi) => {
      const params = new URLSearchParams({ name: poi.query, allowMapResultImage: 'true' });
      if (primaryLat != null) { params.set('lat', primaryLat); params.set('lng', primaryLng); }
      try {
        const r = await fetch(`${mcpHubUrl}/api/place-search?${params}`);
        if (!r.ok) { poi.status = 'not-found'; return; }
        const d = await r.json();
        if (d.error || !d.place_id) { poi.status = 'not-found'; return; }
        poi.status = 'success';
        poi.name = d.name || poi.query;
        poi.placeId = d.place_id;
        poi.coordinates = d.coordinates
          ? { lat: d.coordinates.latitude, lng: d.coordinates.longitude }
          : null;
        poi.address = d.address;
        poi.rating = d.rating;
        poi.reviewCount = d.reviewCount;
        poi.imageUrl = d.image || d.googleImage || poi.imageUrl;
        poi.description = d.description;
        poi.googleMapsUrl = d.googleMapsUrl;
      } catch {
        poi.status = 'not-found';
      }
    }));
  }

  // ── Step 4: Deduplicate by placeId ──
  const seen = new Set();
  const deduped = pois.filter(p => {
    if (p.status !== 'success' || !p.placeId) return true; // keep not-found
    if (seen.has(p.placeId)) return false;
    seen.add(p.placeId);
    return true;
  });

  const duplicatesRemoved = pois.length - deduped.length;

  // Cache full data (instant mode — POI names, re-geocode on hit for freshness)
  if (cacheKey) {
    setCacheEntry(cacheKey, {
      pois: deduped.map(p => ({
        name: p.name || p.query,
        location: p.address,
        placeId: p.placeId,
        coordinates: p.coordinates,
        description: p.description,
        imageUrl: p.imageUrl,
      })),
      sources: [],
      primaryLocation: primaryLat != null ? `${primaryLat},${primaryLng}` : null,
      primaryLocationCoords: primaryLat != null ? { lat: primaryLat, lng: primaryLng } : null,
      _videoMeta: videoMeta || null,
      _instant: true,
    });
  }

  // ── Step 5: Render POI cards + map ──
  let rendered = 0;
  const mapPois = [];

  for (const poi of deduped) {
    rendered++; totalPois++;
    appendPoiCard(poisEl, poi);
    if (poi.status === 'success' && poi.coordinates) {
      mapPois.push({ name: poi.name, lat: poi.coordinates.lat, lng: poi.coordinates.lng });
    }
  }

  if (mapPois.length > 0) {
    initMap(index, mapPois);
  }

  const label = `${rendered} POI${rendered !== 1 ? 's' : ''} found`;
  const dupNote = duplicatesRemoved > 0 ? ` (${duplicatesRemoved} duplicate${duplicatesRemoved !== 1 ? 's' : ''} removed)` : '';
  statusEl.innerHTML = `<span class="done">${label}${dupNote}</span>`;
}

function appendPoiCard(container, poi, videoCtx) {
  const found = poi.status === 'success';
  const displayName = found ? poi.name : poi.query;
  const num = parseInt(poi.id.split('-')[1]) + 1;
  const img = (found && poi.imageUrl)
    ? `<img class="poi-image" src="${escapeHtml(poi.imageUrl)}" alt="" loading="lazy">`
    : `<div class="poi-num">${num}</div>`;

  const timestamp = poi.timelineSeconds
    ? `<span class="poi-stat poi-timestamp">${formatTimestamp(poi.timelineSeconds)}</span>`
    : '';

  const card = document.createElement('div');
  card.className = 'poi-card' + (found ? '' : ' not-found');
  card.innerHTML = `
    ${img}
    <div class="poi-body">
      <div class="poi-name">${escapeHtml(displayName)}</div>
      ${found && poi.address ? `<div class="poi-address">${escapeHtml(poi.address)}</div>` : ''}
      ${!found ? `<div class="poi-address" style="color:#b88a3a">Not found — click to search</div>` : ''}
      <div class="poi-stats">
        ${found && poi.rating ? `<span class="poi-stat"><span class="star">★</span> ${poi.rating}${poi.reviewCount ? ` (${poi.reviewCount})` : ''}</span>` : ''}
        ${timestamp}
      </div>
    </div>
    <button class="poi-save-btn" type="button" title="Save to drawer">＋</button>`;

  // Save button
  const saveBtn = card.querySelector('.poi-save-btn');
  saveBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const drawerItem = {
      id: crypto.randomUUID(),
      savedAt: Date.now(),
      videoTitle: videoCtx?.videoTitle || '',
      videoUrl: videoCtx?.videoUrl || '',
      videoThumb: videoCtx?.videoThumb || null,
      meTitle: poi.name || poi.query,
      meTimeOfDay: null,
      meDuration: null,
      meNarrative: null,
      pois: [{
        name: poi.name || poi.query,
        coordinates: poi.coordinates || null,
        imageUrl: poi.imageUrl || null,
        rating: poi.rating || null,
        address: poi.address || null,
        quote: null,
        videoTimestamp: null,
      }],
    };
    await saveToDrawer(drawerItem);
    saveBtn.textContent = '✓';
    saveBtn.classList.add('saved');
    setTimeout(() => {
      saveBtn.textContent = '＋';
      saveBtn.classList.remove('saved');
    }, 1500);
  });

  if (found && poi.googleMapsUrl) {
    card.addEventListener('click', () => chrome.tabs.create({ url: poi.googleMapsUrl }));
  } else if (found && poi.coordinates) {
    card.addEventListener('click', () => chrome.tabs.create({ url: `https://www.google.com/maps/search/?api=1&query=${poi.coordinates.lat},${poi.coordinates.lng}` }));
  } else {
    card.addEventListener('click', () => chrome.tabs.create({ url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(poi.query)}` }));
  }

  container.appendChild(card);
}

// Render a collapsible sources bar above the POI list
function appendSourcesBar(container, sources) {
  const bar = document.createElement('div');
  bar.className = 'sources-bar';
  bar.innerHTML = `<span class="sources-label">Sources</span>` +
    sources.map((s, i) => {
      const label = s.title || `#${i + 1}`;
      if (s.url) return `<a class="source-chip" href="${escapeHtml(s.url)}" target="_blank" title="${escapeHtml(label)}">${escapeHtml(label.length > 30 ? label.slice(0, 30) + '…' : label)}</a>`;
      return `<span class="source-chip">${escapeHtml(label)}</span>`;
    }).join('');
  container.appendChild(bar);
}

// Format seconds into mm:ss or h:mm:ss
function formatTimestamp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Shape-aware rendering from cache — editorial layout with ME sections + stop cards
async function renderShapeFromCache(poisEl, cached, deduped, index) {
  const mes = cached.microExperiences || [];
  const mapPois = [];

  const videoCtx = {
    videoTitle: cached.videoTitle || cached._videoMeta?.title || '',
    videoUrl: cached._sourceUrl || '',
    videoThumb: cached._videoMeta?.thumbnailUrl || null,
  };

  // Store for view toggling
  sectionData[index] = { deduped, cached, videoCtx };

  // Show global view toggle if we have MEs
  if (mes.length > 0) {
    document.getElementById('globalViewToggle').style.display = 'flex';
  }

  if (mes.length > 0) {
    mes.forEach((me, meIdx) => {
      const mePois = (me.stopRefs || [])
        .map(ref => ({ ...deduped[ref.poiIndex], _ref: ref }))
        .filter(p => p.name);

      mePois.forEach(p => {
        totalPois++;
        if (p.status === 'success' && p.coordinates) {
          mapPois.push({ name: p.name, lat: p.coordinates.lat, lng: p.coordinates.lng });
        }
      });

      const card = buildMeAccordionCard(me, meIdx, mePois, videoCtx);
      poisEl.appendChild(card);
    });
  } else {
    for (const poi of deduped) {
      totalPois++;
      if (poi.status === 'success' && poi.coordinates) {
        mapPois.push({ name: poi.name, lat: poi.coordinates.lat, lng: poi.coordinates.lng });
      }
    }
    for (const poi of deduped) {
      appendPoiCard(poisEl, poi, videoCtx);
    }
  }

  if (mapPois.length > 0) initMap(index, mapPois);
}

// ─── Render from cache (re-geocode for fresh coordinates, like web app) ───

// Render from cache — matches web app behavior:
//   _instant: true  → re-geocode POI names (coordinates may be stale)
//   _instant: false → return cached data directly, skip geocoding
async function renderFromCache(poisEl, cached, mcpHubUrl, index) {
  const statusEl = document.getElementById(`url-status-${index}`);

  const cachedPois = cached.pois || [];
  const coords = cached.primaryLocationCoords;
  const primaryLat = coords?.lat ?? cached.primaryLat ?? null;
  const primaryLng = coords?.lng ?? cached.primaryLng ?? null;

  if (cached._instant) {
    // Instant mode: re-geocode POI names for fresh coordinates/images
    statusEl.innerHTML = `<div class="spinner"></div> <span>Geocoding ${cachedPois.length} cached POIs…</span>`;

    const pois = cachedPois.map((p, i) => ({
      id: `poi-${i}`,
      query: p.name,
      name: p.name,
      address: p.location || p.address,
      status: 'pending',
      imageUrl: p.imageUrl || null,
      rating: p.rating || null,
      mentions: p.mentions || [],
      highlight: p.highlight || null,
      category: p.category || null,
      neighborhood: p.neighborhood || null,
    }));

    const BATCH = 4;
    for (let i = 0; i < pois.length; i += BATCH) {
      const batch = pois.slice(i, i + BATCH);
      await Promise.all(batch.map(poi => geocodePoi(poi, mcpHubUrl, primaryLat, primaryLng)));
    }

    // Deduplicate
    const seen = new Set();
    const deduped = pois.filter(p => {
      if (p.status !== 'success' || !p.placeId) return true;
      if (seen.has(p.placeId)) return false;
      seen.add(p.placeId);
      return true;
    });

    // Shape-aware rendering
    await renderShapeFromCache(poisEl, cached, deduped, index);

    const age = cached.cachedAt ? Math.round((Date.now() - cached.cachedAt) / 60000) : '?';
    const ageLabel = age < 1 ? 'just now' : `${age}m ago`;
    const shapeLabel = cached.shape ? ` (${cached.shape})` : '';
    statusEl.innerHTML = `<span class="done">${deduped.length} POIs${shapeLabel} (cached ${ageLabel}, re-geocoded)</span>`;

  } else {
    // Deep/entity mode: return cached data directly, no geocoding
    const pois = cachedPois.map((p, i) => ({
      id: `poi-${i}`,
      query: p.name,
      name: p.name,
      address: p.location || p.address,
      coordinates: p.coordinates || null,
      placeId: p.placeId || p.place_id || null,
      status: p.coordinates ? 'success' : 'not-found',
      imageUrl: p.imageUrl,
      rating: p.rating,
      mentions: p.mentions || [],
      category: p.category || null,
      neighborhood: p.neighborhood || null,
    }));

    // Deduplicate
    const seen = new Set();
    const deduped = pois.filter(p => {
      if (p.status !== 'success' || !p.placeId) return true;
      if (seen.has(p.placeId)) return false;
      seen.add(p.placeId);
      return true;
    });

    await renderShapeFromCache(poisEl, cached, deduped, index);

    const age = cached.cachedAt ? Math.round((Date.now() - cached.cachedAt) / 60000) : '?';
    const ageLabel = age < 1 ? 'just now' : `${age}m ago`;
    const shapeLabel = cached.shape ? ` (${cached.shape})` : '';
    statusEl.innerHTML = `<span class="done">${deduped.length} POIs${shapeLabel} (cached ${ageLabel})</span>`;
  }
}

// ─── Map helpers ───

function initMap(index, mapPois) {
  const el = document.getElementById(`url-map-${index}`);
  if (!el || !mapPois.length) return null;

  // Destroy existing map if the container was reused
  if (activeMaps[index]) {
    try { activeMaps[index].remove(); } catch {}
    delete activeMaps[index];
  }

  el.style.display = 'block';

  const c = mapPois[mapPois.length - 1];
  const map = L.map(el, { scrollWheelZoom: false, zoomControl: false, attributionControl: false })
    .setView([c.lat, c.lng], 12);

  // Warm-toned tiles with sepia filter (applied via CSS)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(map);

  // Custom numbered pins using divIcon
  mapPois.forEach((p, i) => {
    const icon = L.divIcon({
      className: 'custom-pin',
      html: `<div class="pin-body">${i + 1}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    L.marker([p.lat, p.lng], { icon }).addTo(map).bindTooltip(p.name, {
      className: 'pin-label',
      direction: 'top',
      offset: [0, -16],
    });
  });

  if (mapPois.length > 1) map.fitBounds(L.latLngBounds(mapPois.map(p => [p.lat, p.lng])), { padding: [14, 14] });
  activeMaps[index] = map;
  return map;
}

// ═══════════════════════════════════════════════════
// DRAWER — save MEs, build trips
// ═══════════════════════════════════════════════════

// ── View toggle: switch between Experiences and POIs ──

function renderSectionView(index, view) {
  const data = sectionData[index];
  if (!data) return;
  const poisEl = document.getElementById(`url-pois-${index}`);
  if (!poisEl) return;
  poisEl.innerHTML = '';

  if (view === 'pois') {
    data.deduped.forEach((poi, i) => {
      const found = poi.status === 'success';
      const name = escapeHtml(poi.name || poi.query);
      const imgUrl = (found && poi.imageUrl) ? poi.imageUrl : null;
      const metaParts = [];
      if (poi.address || poi.neighborhood) metaParts.push(`<span class="pin">📍</span> ${escapeHtml(poi.neighborhood || poi.address)}`);
      if (poi.rating) metaParts.push(`<span class="rating">★ ${poi.rating}</span>`);
      const metaHtml = metaParts.length ? `<div class="meta">${metaParts.join('<span class="sep"> · </span>')}</div>` : '';

      // If we have an image, show it large; otherwise show number
      const imageBlock = imgUrl
        ? `<div class="poi-list-img" style="background-image:url('${escapeHtml(imgUrl)}')"></div>`
        : `<div class="poi-list-num">${i + 1}</div>`;

      const card = document.createElement('div');
      card.className = 'poi-list-card';
      card.innerHTML = `
        ${imageBlock}
        <div class="poi-list-body">
          <div class="poi-list-name">${name}</div>
          ${metaHtml}
        </div>
        <button class="poi-save-btn" type="button" title="Save to drawer">＋</button>`;

      // Save button
      const saveBtn = card.querySelector('.poi-save-btn');
      saveBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const drawerItem = {
          id: crypto.randomUUID(), savedAt: Date.now(),
          videoTitle: data.videoCtx?.videoTitle || '',
          videoUrl: data.videoCtx?.videoUrl || '',
          videoThumb: data.videoCtx?.videoThumb || null,
          meTitle: poi.name || poi.query,
          meTimeOfDay: null, meDuration: null, meNarrative: null,
          pois: [{ name: poi.name || poi.query, coordinates: poi.coordinates || null, imageUrl: poi.imageUrl || null, rating: poi.rating || null, address: poi.address || null, quote: null, videoTimestamp: null }],
        };
        await saveToDrawer(drawerItem);
        saveBtn.textContent = '✓';
        saveBtn.classList.add('saved');
        setTimeout(() => { saveBtn.textContent = '＋'; saveBtn.classList.remove('saved'); }, 1500);
      });

      if (found && poi.coordinates) {
        card.addEventListener('click', () => chrome.tabs.create({ url: `https://www.google.com/maps/search/?api=1&query=${poi.coordinates.lat},${poi.coordinates.lng}` }));
      } else {
        card.addEventListener('click', () => chrome.tabs.create({ url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(poi.query || poi.name)}` }));
      }

      poisEl.appendChild(card);
    });
  } else {
    const mes = data.cached.microExperiences || [];
    mes.forEach((me, meIdx) => {
      const mePois = (me.stopRefs || [])
        .map(ref => ({ ...data.deduped[ref.poiIndex], _ref: ref }))
        .filter(p => p.name);
      const card = buildMeAccordionCard(me, meIdx, mePois, data.videoCtx);
      poisEl.appendChild(card);
    });
  }
}

// ── Storage helpers ──

async function getDrawer() {
  const { drawer } = await chrome.storage.local.get('drawer');
  return drawer || { items: [] };
}

async function saveToDrawer(item) {
  const drawer = await getDrawer();
  // Deduplicate by videoUrl + title
  const dedupKey = `${item.videoUrl}::${item.meTitle}`;
  const exists = drawer.items.some(d => `${d.videoUrl}::${d.meTitle}` === dedupKey);
  if (!exists) {
    drawer.items.push(item);
    await chrome.storage.local.set({ drawer });
  }
  updateDrawerBadge();
}

async function removeFromDrawer(id) {
  const drawer = await getDrawer();
  drawer.items = drawer.items.filter(d => d.id !== id);
  await chrome.storage.local.set({ drawer });
  await loadDrawer();
}

function updateDrawerBadge() {
  getDrawer().then(drawer => {
    const badge = document.getElementById('drawerBadge');
    if (!badge) return;
    const count = drawer.items.length;
    badge.textContent = count > 0 ? count : '';
    badge.classList.toggle('visible', count > 0);
  });
}

// ── Load and render drawer tab ──

async function loadDrawer() {
  const drawer = await getDrawer();
  const container = document.getElementById('drawerContent');
  updateDrawerBadge();

  if (drawer.items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>No saved experiences</p>
        <small>Save micro-experiences from extraction results to build a trip</small>
      </div>`;
    return;
  }

  // Group by videoUrl
  const groups = {};
  const order = [];
  for (const item of drawer.items) {
    const key = item.videoUrl || 'unknown';
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(item);
  }

  let html = '';
  for (const key of order) {
    const items = groups[key];
    const first = items[0];
    html += `<div class="drawer-group">`;
    if (first.videoTitle) {
      const thumb = first.videoThumb
        ? `<img class="drawer-group-thumb" src="${escapeHtml(first.videoThumb)}" alt="">`
        : '';
      html += `<div class="drawer-group-header">${thumb}<div class="drawer-group-title">${escapeHtml(first.videoTitle)}</div></div>`;
    }
    items.forEach((item, i) => {
      const metaParts = [];
      if (item.meTimeOfDay) metaParts.push(item.meTimeOfDay);
      if (item.meDuration) metaParts.push(item.meDuration);
      metaParts.push(`${item.pois.length} stop${item.pois.length !== 1 ? 's' : ''}`);
      const metaHtml = metaParts.map(m => `<span class="me-badge">${escapeHtml(m)}</span>`).join('');
      html += `
        <div class="drawer-me">
          <div class="drawer-me-num">${i + 1}</div>
          <div class="drawer-me-info">
            <div class="drawer-me-title">${escapeHtml(item.meTitle)}</div>
            <div class="drawer-me-meta">${metaHtml}</div>
          </div>
          <button class="drawer-me-remove" data-id="${item.id}" title="Remove">&times;</button>
        </div>`;
    });
    html += `</div>`;
  }

  html += `<button id="createTripBtn" class="btn-trip">→ Create Trip (${drawer.items.length} experiences)</button>`;
  container.innerHTML = html;

  // Wire remove buttons
  container.querySelectorAll('.drawer-me-remove').forEach(btn => {
    btn.addEventListener('click', () => removeFromDrawer(btn.dataset.id));
  });

  // Wire create trip
  const tripBtn = document.getElementById('createTripBtn');
  if (tripBtn) tripBtn.addEventListener('click', () => buildTrip(drawer.items));
}

// ── Trip builder ──

let tripMap = null;

async function buildTrip(items) {
  const container = document.getElementById('drawerContent');
  const allPois = [];
  let globalStopIdx = 0;

  let html = `<button id="tripBackBtn" class="trip-back">← Back to drawer</button>`;

  items.forEach((item, meIdx) => {
    if (meIdx > 0) {
      html += `<div class="trip-divider">${escapeHtml(item.meTitle)}</div>`;
    } else {
      html += `<div class="trip-me-label">${escapeHtml(item.meTitle)}</div>`;
      if (item.videoTitle) html += `<div class="trip-source">from ${escapeHtml(item.videoTitle)}</div>`;
    }

    html += `<div class="me-stops" style="margin-bottom:8px">`;
    item.pois.forEach(p => {
      globalStopIdx++;
      if (p.coordinates) {
        allPois.push({ name: p.name, lat: p.coordinates.lat, lng: p.coordinates.lng });
      }
      const thumbImg = p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy">` : '';
      const tsBadge = p.videoTimestamp ? `<span class="time">▶ ${escapeHtml(p.videoTimestamp)}</span>` : '';
      const metaParts = [];
      if (p.address) metaParts.push(`<span class="pin">📍</span> ${escapeHtml(p.address)}`);
      if (p.rating) metaParts.push(`<span class="rating">★ ${p.rating}</span>`);
      const metaHtml = metaParts.length ? `<div class="meta">${metaParts.join('<span class="sep"> · </span>')}</div>` : '';
      const quoteHtml = p.quote ? `<div class="quote">${escapeHtml(p.quote)}</div>` : '';

      html += `
        <div class="me-stop">
          <div class="thumb-wrap">${thumbImg}<div class="num-badge">${globalStopIdx}</div></div>
          <div class="body">
            <div class="top-line"><h4>${escapeHtml(p.name)}</h4>${tsBadge}</div>
            ${metaHtml}
            ${quoteHtml}
          </div>
        </div>`;
    });
    html += `</div>`;
  });

  container.innerHTML = html;

  // Back button
  document.getElementById('tripBackBtn').addEventListener('click', () => loadDrawer());

  // Combined map
  if (allPois.length > 0) {
    const mapEl = document.createElement('div');
    mapEl.className = 'mini-map';
    mapEl.id = 'trip-map';
    mapEl.style.height = '180px';
    container.insertBefore(mapEl, container.firstChild.nextSibling);

    if (tripMap) { try { tripMap.remove(); } catch {} tripMap = null; }

    tripMap = L.map(mapEl, { scrollWheelZoom: false, zoomControl: false, attributionControl: false })
      .setView([allPois[0].lat, allPois[0].lng], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(tripMap);

    allPois.forEach((p, i) => {
      const icon = L.divIcon({
        className: 'custom-pin',
        html: `<div class="pin-body">${i + 1}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      L.marker([p.lat, p.lng], { icon }).addTo(tripMap).bindTooltip(p.name, {
        className: 'pin-label', direction: 'top', offset: [0, -16],
      });
    });

    if (allPois.length > 1) tripMap.fitBounds(L.latLngBounds(allPois.map(p => [p.lat, p.lng])), { padding: [14, 14] });
  }
}

// ═══════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  loadItems();
  loadSettings();
  updateDrawerBadge();

  // Tab switching
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  // Capture tab
  document.getElementById('captureBtn').addEventListener('click', captureCurrentPage);
  document.getElementById('exportCsvBtn').addEventListener('click', exportToCSV);
  document.getElementById('exportJsonBtn').addEventListener('click', exportToJSON);
  document.getElementById('clearBtn').addEventListener('click', clearAllItems);
  document.getElementById('extractBtn').addEventListener('click', startExtraction);

  // Settings
  document.getElementById('settingsToggle').addEventListener('click', toggleSettings);
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
});
