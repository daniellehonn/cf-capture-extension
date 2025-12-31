// Load and display captured videos
async function loadVideos() {
  const result = await chrome.storage.local.get(['capturedVideos']);
  const videos = result.capturedVideos || [];

  const videoCount = document.getElementById('videoCount');
  const videoList = document.getElementById('videoList');

  videoCount.textContent = `${videos.length} video${videos.length !== 1 ? 's' : ''}`;

  if (videos.length === 0) {
    videoList.innerHTML = `
      <div class="empty-state">
        <p>No videos yet</p>
        <small>Click Capture on any YouTube video</small>
      </div>
    `;
    return;
  }

  videoList.innerHTML = videos.map((video, index) => {
    const date = new Date(video.capturedAt);
    const formattedDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    return `
    <div class="video-item">
      <img src="${video.thumbnail}" alt="${escapeHtml(video.title)}" class="video-thumbnail" data-url="${video.url}">
      <div class="video-info">
        <div class="video-title" data-url="${video.url}">${escapeHtml(video.title)}</div>
        <div class="video-meta">
          <span class="meta-item">${escapeHtml(video.creator || 'Unknown')}</span>
          <span class="meta-separator">•</span>
          <span class="video-date">${formattedDate}</span>
        </div>
        <div class="video-stats">
          <span class="stat-item">
            <span class="meta-icon">👁</span>
            ${escapeHtml(video.views || '0')}
          </span>
          <span class="stat-item">
            <span class="meta-icon">👍</span>
            ${escapeHtml(video.likes || '0')}
          </span>
          <span class="stat-item">
            <span class="meta-icon">💬</span>
            ${escapeHtml(video.comments || '0')}
          </span>
        </div>
      </div>
      <button class="delete-btn" data-index="${index}" title="Remove">×</button>
    </div>
  `}).join('');

  // Add click handlers for thumbnails and titles
  document.querySelectorAll('.video-thumbnail, .video-title').forEach(el => {
    el.addEventListener('click', () => {
      const url = el.dataset.url;
      if (url) chrome.tabs.create({ url });
    });
  });

  // Add event listeners to delete buttons
  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const index = parseInt(e.target.dataset.index);
      await deleteVideo(index);
    });
  });
}

// Delete a single video
async function deleteVideo(index) {
  const result = await chrome.storage.local.get(['capturedVideos']);
  const videos = result.capturedVideos || [];

  videos.splice(index, 1);
  await chrome.storage.local.set({ capturedVideos: videos });
  await loadVideos();
}

// Clear all videos
async function clearAllVideos() {
  if (!confirm('Are you sure you want to clear all captured videos?')) {
    return;
  }

  await chrome.storage.local.set({ capturedVideos: [] });
  await loadVideos();
}

// Export videos to CSV
async function exportToCSV() {
  const result = await chrome.storage.local.get(['capturedVideos']);
  const videos = result.capturedVideos || [];

  if (videos.length === 0) {
    alert('No videos to export');
    return;
  }

  // Create CSV content
  const headers = ['Title', 'Creator', 'Views', 'Likes', 'Comments', 'URL', 'Video ID', 'Captured At'];
  const rows = videos.map(video => [
    `"${(video.title || '').replace(/"/g, '""')}"`,
    `"${(video.creator || '').replace(/"/g, '""')}"`,
    `"${video.views || '0'}"`,
    `"${video.likes || '0'}"`,
    `"${video.comments || '0'}"`,
    video.url,
    video.videoId,
    new Date(video.capturedAt).toISOString()
  ]);

  const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');

  // Create and trigger download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `youtube-captures-${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Helper function to escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadVideos();

  document.getElementById('exportBtn').addEventListener('click', exportToCSV);
  document.getElementById('clearBtn').addEventListener('click', clearAllVideos);
});
