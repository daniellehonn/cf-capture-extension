// Open side panel when extension icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Handle messages from sidepanel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureItem') {
    handleItemCapture(request.item).then(sendResponse);
    return true;
  }
});

// Save a captured item
async function handleItemCapture(item) {
  try {
    const result = await chrome.storage.local.get(['capturedItems']);
    const items = result.capturedItems || [];

    // Check for duplicate URL — update if exists
    const existingIndex = items.findIndex(i => i.url === item.url);

    if (existingIndex !== -1) {
      items[existingIndex] = item;
    } else {
      items.unshift(item);
    }

    await chrome.storage.local.set({ capturedItems: items });
    await updateBadge(items.length);

    return { success: true };
  } catch (error) {
    console.error('Error saving item:', error);
    return { success: false, error: error.message };
  }
}

// Update badge count
async function updateBadge(count) {
  if (count > 0) {
    await chrome.action.setBadgeText({ text: count.toString() });
    await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// Initialize badge on install/start
chrome.runtime.onInstalled.addListener(async () => {
  const result = await chrome.storage.local.get(['capturedItems']);
  const items = result.capturedItems || [];
  await updateBadge(items.length);
});

// Update badge when storage changes
chrome.storage.onChanged.addListener(async (changes, namespace) => {
  if (namespace === 'local' && changes.capturedItems) {
    const newCount = changes.capturedItems.newValue?.length || 0;
    await updateBadge(newCount);
  }
});
