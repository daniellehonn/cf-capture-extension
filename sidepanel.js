// Load and display captured items
async function loadItems() {
  const result = await chrome.storage.local.get(['capturedItems']);
  const items = result.capturedItems || [];

  const itemCount = document.getElementById('itemCount');
  const itemList = document.getElementById('itemList');

  itemCount.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;

  if (items.length === 0) {
    itemList.innerHTML = `
      <div class="empty-state">
        <p>No pages captured yet</p>
        <small>Click "Capture Current Page" to start</small>
      </div>
    `;
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
    </div>
  `}).join('');

  // Click handlers for URLs — open in new tab
  document.querySelectorAll('.item-url').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: el.href });
    });
  });

  // Delete button handlers
  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const index = parseInt(e.target.dataset.index);
      await deleteItem(index);
    });
  });
}

// Extract YouTube video ID from a URL
function getYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') {
      return u.searchParams.get('v') || null;
    }
    if (u.hostname === 'youtu.be') {
      return u.pathname.slice(1) || null;
    }
  } catch {}
  return null;
}

// Extract metadata from a YouTube video page via scripting
async function extractYouTubeData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let description = '';

        // 1. Try ytInitialPlayerResponse (most reliable, has full description)
        try {
          const playerData = ytInitialPlayerResponse?.videoDetails;
          if (playerData?.shortDescription) {
            description = playerData.shortDescription;
          }
        } catch {}

        // 2. Try ytInitialData (secondary structured source)
        if (!description) {
          try {
            const desc = ytInitialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[1]?.videoSecondaryInfoRenderer?.attributedDescriptionBodyText?.content;
            if (desc) description = desc;
          } catch {}
        }

        // 3. Try DOM selectors (fragile but worth trying)
        if (!description) {
          const selectors = [
            '#attributed-snippet-text',
            '#description-inner',
            'ytd-expandable-video-description-body-renderer',
            '#description-inline-expander',
            'yt-attributed-string.ytd-expandable-video-description-body-renderer'
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim()) {
              description = el.textContent.trim();
              break;
            }
          }
        }

        // 4. Final fallback: og:description meta tag
        if (!description) {
          const ogDesc = document.querySelector('meta[property="og:description"]');
          description = ogDesc ? ogDesc.getAttribute('content') || '' : '';
        }

        return { description };
      }
    });
    return results?.[0]?.result || { description: '' };
  } catch {
    return { description: '' };
  }
}

// Extract thumbnail and description from a generic page via scripting
async function extractPageData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Thumbnail: prefer og:image, then twitter:image
        let thumbnail = '';
        const ogImg = document.querySelector('meta[property="og:image"]');
        if (ogImg) {
          thumbnail = ogImg.getAttribute('content') || '';
        }
        if (!thumbnail) {
          const twImg = document.querySelector('meta[name="twitter:image"], meta[property="twitter:image"]');
          thumbnail = twImg ? twImg.getAttribute('content') || '' : '';
        }

        // Description: prefer og:description, then meta description
        let description = '';
        const ogDesc = document.querySelector('meta[property="og:description"]');
        if (ogDesc) {
          description = ogDesc.getAttribute('content') || '';
        }
        if (!description) {
          const metaDesc = document.querySelector('meta[name="description"]');
          description = metaDesc ? metaDesc.getAttribute('content') || '' : '';
        }

        return { thumbnail, description };
      }
    });
    return results?.[0]?.result || { thumbnail: '', description: '' };
  } catch {
    return { thumbnail: '', description: '' };
  }
}

// Capture the current page
async function captureCurrentPage() {
  const btn = document.getElementById('captureBtn');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
      showError(btn, 'Cannot capture this page');
      return;
    }

    let thumbnail = '';
    let description = '';

    // YouTube: use video thumbnail + scrape description
    const ytVideoId = getYouTubeVideoId(tab.url);
    if (ytVideoId) {
      thumbnail = `https://img.youtube.com/vi/${ytVideoId}/mqdefault.jpg`;
      const ytData = await extractYouTubeData(tab.id);
      description = ytData.description;
    } else {
      // Generic page: extract og:image + description
      const pageData = await extractPageData(tab.id);
      thumbnail = pageData.thumbnail;
      description = pageData.description;
    }

    const item = {
      id: crypto.randomUUID(),
      url: tab.url,
      title: tab.title || 'Untitled',
      description,
      thumbnail,
      capturedAt: Date.now()
    };

    const response = await chrome.runtime.sendMessage({
      action: 'captureItem',
      item
    });

    if (response && response.success) {
      // Show success state
      const originalHTML = btn.innerHTML;
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Captured!
      `;
      btn.classList.add('captured');

      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.classList.remove('captured');
      }, 1500);

      await loadItems();
    } else {
      showError(btn, 'Failed to save');
    }
  } catch (error) {
    console.error('Error capturing page:', error);
    showError(btn, 'Capture failed');
  }
}

// Show a brief error on the capture button
function showError(btn, message) {
  const originalHTML = btn.innerHTML;
  btn.textContent = message;
  btn.classList.add('error');
  setTimeout(() => {
    btn.innerHTML = originalHTML;
    btn.classList.remove('error');
  }, 1500);
}

// Delete a single item
async function deleteItem(index) {
  const result = await chrome.storage.local.get(['capturedItems']);
  const items = result.capturedItems || [];

  items.splice(index, 1);
  await chrome.storage.local.set({ capturedItems: items });
  await loadItems();
}

// Clear all items
async function clearAllItems() {
  if (!confirm('Are you sure you want to clear all captured items?')) {
    return;
  }

  await chrome.storage.local.set({ capturedItems: [] });
  await loadItems();
}

// Export to CSV
async function exportToCSV() {
  const result = await chrome.storage.local.get(['capturedItems']);
  const items = result.capturedItems || [];

  if (items.length === 0) {
    alert('No items to export');
    return;
  }

  const headers = ['Title', 'URL', 'Description', 'Captured At'];
  const rows = items.map(item => [
    `"${(item.title || '').replace(/"/g, '""')}"`,
    item.url,
    `"${(item.description || '').replace(/"/g, '""')}"`,
    new Date(item.capturedAt).toISOString()
  ]);

  const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  downloadFile(csvContent, 'text/csv;charset=utf-8;', `contextforce-captures-${new Date().toISOString().split('T')[0]}.csv`);
}

// Export to JSON
async function exportToJSON() {
  const result = await chrome.storage.local.get(['capturedItems']);
  const items = result.capturedItems || [];

  if (items.length === 0) {
    alert('No items to export');
    return;
  }

  const jsonContent = JSON.stringify(items, null, 2);
  downloadFile(jsonContent, 'application/json;charset=utf-8;', `contextforce-captures-${new Date().toISOString().split('T')[0]}.json`);
}

// Helper: trigger file download
function downloadFile(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Helper: escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadItems();

  document.getElementById('captureBtn').addEventListener('click', captureCurrentPage);
  document.getElementById('exportCsvBtn').addEventListener('click', exportToCSV);
  document.getElementById('exportJsonBtn').addEventListener('click', exportToJSON);
  document.getElementById('clearBtn').addEventListener('click', clearAllItems);
});
