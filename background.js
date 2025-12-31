// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureVideo') {
    handleVideoCapture(request.video).then(sendResponse);
    return true; // Keep message channel open for async response
  }
});

// Handle video capture
async function handleVideoCapture(videoInfo) {
  try {
    console.log('[Capture-Extension] Background: Received video info:', videoInfo);

    // Get existing videos
    const result = await chrome.storage.local.get(['capturedVideos']);
    const videos = result.capturedVideos || [];

    console.log('[Capture-Extension] Background: Existing videos count:', videos.length);
    console.log('[Capture-Extension] Background: Existing video IDs:', videos.map(v => v.videoId));

    // Check if video already exists
    const existingIndex = videos.findIndex(v => v.videoId === videoInfo.videoId);

    if (existingIndex !== -1) {
      console.log('[Capture-Extension] Background: Updating existing video at index:', existingIndex);
      // Update existing video
      videos[existingIndex] = videoInfo;
    } else {
      console.log('[Capture-Extension] Background: Adding new video');
      // Add new video
      videos.unshift(videoInfo); // Add to beginning of array
    }

    console.log('[Capture-Extension] Background: Saving videos:', videos.map(v => ({ id: v.videoId, title: v.title })));

    // Save to storage
    await chrome.storage.local.set({ capturedVideos: videos });

    // Set badge text
    await updateBadge(videos.length);

    return { success: true };
  } catch (error) {
    console.error('[Capture-Extension] Error saving video:', error);
    return { success: false, error: error.message };
  }
}

// Update badge count
async function updateBadge(count) {
  if (count > 0) {
    await chrome.action.setBadgeText({ text: count.toString() });
    await chrome.action.setBadgeBackgroundColor({ color: '#FF0000' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// Initialize badge on extension install/start
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get(['capturedVideos']);
  const videos = result.capturedVideos || [];
  await updateBadge(videos.length);
});

// Update badge when storage changes
chrome.storage.onChanged.addListener(async (changes, namespace) => {
  if (namespace === 'local' && changes.capturedVideos) {
    const newCount = changes.capturedVideos.newValue?.length || 0;
    await updateBadge(newCount);
  }
});
