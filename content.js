// Extract video ID from URL
function getVideoId() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('v');
}

// Get video information from the page
function getVideoInfo() {
  const videoId = getVideoId();

  if (!videoId) {
    return null;
  }

  // IMPORTANT: Always scrape from DOM, not ytInitialData
  // ytInitialData can be stale after client-side navigation
  let title = 'Unknown Title';
  let creator = 'Unknown Creator';
  let views = '0';
  let likes = '0';
  let comments = '0';

  // Get title from DOM (most reliable)
  const titleSelectors = [
    'h1.ytd-watch-metadata yt-formatted-string',
    'h1.ytd-video-primary-info-renderer yt-formatted-string',
    'h1.title',
    'yt-formatted-string.ytd-watch-metadata'
  ];

  for (const selector of titleSelectors) {
    const element = document.querySelector(selector);
    if (element && element.textContent.trim()) {
      title = element.textContent.trim();
      break;
    }
  }

  // Get creator from DOM
  const creatorSelectors = [
    '#text.ytd-channel-name a',
    '#channel-name a.yt-simple-endpoint',
    'ytd-video-owner-renderer a',
    '#owner-name a',
    'ytd-watch-metadata ytd-video-owner-renderer yt-formatted-string a'
  ];

  for (const selector of creatorSelectors) {
    const element = document.querySelector(selector);
    if (element && element.textContent.trim()) {
      creator = element.textContent.trim();
      break;
    }
  }

  // Get views from DOM
  const viewsSelectors = [
    'ytd-watch-metadata yt-formatted-string.view-count',
    '#info .view-count',
    '#info yt-formatted-string.view-count',
    'yt-view-count-renderer',
    '.view-count'
  ];

  console.log('[Capture-Extension] Searching for views...');

  for (const selector of viewsSelectors) {
    const element = document.querySelector(selector);
    if (element) {
      const text = element.textContent.trim();
      console.log('[Capture-Extension] Selector:', selector, 'Text:', text);
      // Remove "views" text and clean up
      const parsedViews = text.replace(/views?/i, '').replace(/,/g, '').trim();
      // Verify it's actually a number (not text like title)
      if (parsedViews && /^[\d.KMB]+$/.test(parsedViews)) {
        views = parsedViews;
        console.log('[Capture-Extension] ✓ Found views:', views);
        break;
      }
    }
  }

  console.log('[Capture-Extension] Final views value:', views);

  // Get likes from DOM
  const likeSelectors = [
    'ytd-segmented-like-dislike-button-renderer #segmented-like-button button[aria-pressed="false"]',
    '#segmented-like-button button',
    'like-button-view-model button'
  ];

  console.log('[Capture-Extension] Looking for likes...');

  for (const selector of likeSelectors) {
    const element = document.querySelector(selector);
    if (element) {
      console.log('[Capture-Extension] Found like element with selector:', selector);
      const ariaLabel = element.getAttribute('aria-label');
      console.log('[Capture-Extension] aria-label:', ariaLabel);

      if (ariaLabel) {
        // Try multiple patterns
        const patterns = [
          /like this video along with ([\d.,]+[KMB]?)\s+other people/i,
          /([\d.,]+[KMB]?)\s*likes?/i,
          /(\d+[.,]?\d*[KMB]?)/i
        ];

        for (const pattern of patterns) {
          const match = ariaLabel.match(pattern);
          if (match) {
            console.log('[Capture-Extension] Matched likes with pattern:', pattern, 'Result:', match[1]);
            likes = match[1];
            break;
          }
        }
        if (likes !== '0') break;
      }

      // Try text content
      const text = element.textContent.trim();
      console.log('[Capture-Extension] Button text content:', text);

      if (text && text !== 'Like' && text !== 'Likes' && text !== '') {
        likes = text;
        console.log('[Capture-Extension] Using text as likes:', likes);
        break;
      }
    }
  }

  console.log('[Capture-Extension] Final likes value:', likes);

  // Get comments from DOM
  const commentSelectors = [
    '#comments #count yt-formatted-string',
    'ytd-comments-header-renderer #count yt-formatted-string',
    '#comments .count-text yt-formatted-string'
  ];

  for (const selector of commentSelectors) {
    const element = document.querySelector(selector);
    if (element) {
      const text = element.textContent.trim();
      const match = text.match(/([\d.,]+[KMB]?)\s*comments?/i);
      if (match) {
        comments = match[1];
        break;
      }
    }
  }

  // Verify that videoId matches the current page URL
  const currentUrlVideoId = new URLSearchParams(window.location.search).get('v');
  if (currentUrlVideoId !== videoId) {
    console.log('[Capture-Extension] WARNING: URL videoId mismatch! Using URL videoId:', currentUrlVideoId);
  }

  // Debug logging
  console.log('[Capture-Extension] Scraping results:', {
    videoId,
    title,
    creator,
    views,
    likes,
    comments
  });

  const videoInfo = {
    videoId: currentUrlVideoId || videoId, // Use the videoId from URL
    title,
    creator,
    views,
    likes,
    comments,
    url: `https://www.youtube.com/watch?v=${currentUrlVideoId || videoId}`,
    thumbnail: `https://img.youtube.com/vi/${currentUrlVideoId || videoId}/mqdefault.jpg`,
    capturedAt: Date.now()
  };

  console.log('[Capture-Extension] Complete video info object:', videoInfo);

  return videoInfo;
}

// Create capture button
function createCaptureButton() {
  const button = document.createElement('button');
  button.id = 'yt-capture-btn';
  button.className = 'yt-capture-button';
  button.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
      <circle cx="12" cy="13" r="4"></circle>
    </svg>
    Capture
  `;
  return button;
}

// Check if button exists
function buttonExists() {
  return document.getElementById('yt-capture-btn') !== null;
}

// Inject the capture button
function injectCaptureButton() {
  // Only inject on video pages
  if (!window.location.pathname.includes('/watch')) {
    return;
  }

  // Don't inject if already exists
  if (buttonExists()) {
    return;
  }

  // Find the actions container
  const actionsContainer = document.querySelector('#top-level-buttons-computed');
  if (!actionsContainer) {
    return;
  }

  const button = createCaptureButton();

  // Add click handler
  button.addEventListener('click', handleCapture);

  // Insert at the beginning of the container
  actionsContainer.insertBefore(button, actionsContainer.firstChild);

  console.log('YouTube Video Capture: Button injected');
}

// Handle capture button click
async function handleCapture() {
  const videoInfo = getVideoInfo();

  if (!videoInfo) {
    alert('Could not capture video. Please make sure you are on a YouTube video page.');
    return;
  }

  try {
    // Send message to background script to save the video
    const response = await chrome.runtime.sendMessage({
      action: 'captureVideo',
      video: videoInfo
    });

    if (response && response.success) {
      // Show success animation
      const button = document.getElementById('yt-capture-btn');
      const originalHTML = button.innerHTML;
      button.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        Saved!
      `;
      button.classList.add('captured');

      setTimeout(() => {
        button.innerHTML = originalHTML;
        button.classList.remove('captured');
      }, 2000);
    }
  } catch (error) {
    console.error('Error capturing video:', error);
    alert('Failed to capture video. Please try again.');
  }
}

// Simple initialization with interval
let initInterval = null;
let checkCount = 0;
const MAX_CHECKS = 20;

function startInjectionCheck() {
  if (initInterval) return;

  injectCaptureButton();

  initInterval = setInterval(() => {
    checkCount++;
    if (checkCount > MAX_CHECKS || buttonExists()) {
      clearInterval(initInterval);
      initInterval = null;
      return;
    }
    injectCaptureButton();
  }, 1000);
}

// Watch for URL changes
let currentUrl = window.location.href;

function checkUrlChange() {
  if (window.location.href !== currentUrl) {
    currentUrl = window.location.href;

    // Remove old button if exists
    const oldButton = document.getElementById('yt-capture-btn');
    if (oldButton) {
      oldButton.remove();
    }

    // Start injection for new page
    checkCount = 0;
    startInjectionCheck();
  }
}

// Initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startInjectionCheck);
} else {
  startInjectionCheck();
}

// Check URL changes every second
setInterval(checkUrlChange, 1000);
