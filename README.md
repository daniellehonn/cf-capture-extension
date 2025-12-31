# YouTube Video Capture Extension

A Chrome extension that allows you to easily capture YouTube videos with one click and export them to a CSV spreadsheet.

## Features

- **One-Click Capture**: Add a "Capture" button directly on YouTube video pages
- **Video Storage**: Stores video title, URL, thumbnail, and capture date
- **CSV Export**: Export all captured videos to a spreadsheet-compatible CSV file
- **Visual Feedback**: See captured videos with thumbnails and metadata
- **Badge Counter**: Extension icon shows number of captured videos
- **Duplicate Detection**: Automatically updates existing entries if you recapture a video

## Installation

### Option 1: Load as Unpacked Extension (Development)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked"
5. Select the `capture-extension` directory
6. The extension is now installed!

### Option 2: Creating Icons (Optional)

The extension includes an SVG icon in the `icons/` directory, but you'll need PNG icons for the full experience. To create them:

1. Use `icons/icon.svg` as a base
2. Convert it to PNG at three sizes:
   - 16x16 pixels (icon16.png)
   - 48x48 pixels (icon48.png)
   - 128x128 pixels (icon128.png)
3. Place these files in the `icons/` directory
4. Reload the extension

You can use online tools like:
- https://cloudconvert.com/svg-to-png
- https://convertio.io/svg-png
- Or any image editor (GIMP, Photoshop, etc.)

## Usage

### Capturing Videos

1. Navigate to any YouTube video (e.g., https://www.youtube.com/watch?v=xxxxx)
2. You'll see a red "Capture Video" button near the top action buttons
3. Click the button to capture the video
4. The button will briefly turn green to confirm capture

### Viewing Captured Videos

1. Click the extension icon in your browser toolbar
2. A popup will show all your captured videos with:
   - Video thumbnails
   - Titles
   - URLs
   - Capture dates

### Exporting to CSV

1. Open the extension popup
2. Click the "Export to CSV" button
3. A CSV file will download with all captured videos
4. Open in Excel, Google Sheets, or any spreadsheet application

**CSV Format:**
```
Title,URL,Video ID,Captured At
"Video Title","https://youtube.com/watch?v=xxxxx","xxxxx","2025-12-29T10:30:00.000Z"
```

### Managing Videos

- **Delete Individual Videos**: Click the × button on any video in the popup
- **Clear All Videos**: Click the "Clear All" button (requires confirmation)

## File Structure

```
capture-extension/
├── manifest.json          # Extension configuration
├── popup.html             # Popup interface
├── popup.js               # Popup logic
├── popup.css              # Popup styling
├── content.js             # Content script for YouTube pages
├── content.css            # Styles for injected button
├── background.js          # Service worker for storage management
├── icons/
│   ├── icon.svg           # SVG icon source
│   ├── icon16.png         # 16x16 PNG (to be created)
│   ├── icon48.png         # 48x48 PNG (to be created)
│   ├── icon128.png        # 128x128 PNG (to be created)
│   └── README.md          # Icon instructions
└── README.md              # This file
```

## Technical Details

- **Manifest Version**: 3 (latest Chrome extension standard)
- **Storage**: Chrome's `chrome.storage.local` API
- **Permissions**:
  - `storage`: For saving captured videos
  - `activeTab`: For accessing current tab info
  - `https://www.youtube.com/*`: For injecting content script

## Browser Compatibility

- Google Chrome (Manifest V3)
- Microsoft Edge (Chromium-based)
- Opera (Chromium-based)
- Brave (Chromium-based)

## Troubleshooting

**Button not appearing on YouTube:**
- Refresh the page
- Make sure you're on a video page (URL contains `/watch`)
- Check that the extension is enabled in `chrome://extensions/`

**Export not working:**
- Check that you have videos captured
- Try clearing browser cache and reloading the extension

**Videos not persisting:**
- Videos are stored locally in your browser
- Clearing browser data may delete captured videos
- Consider exporting regularly as backup

## Future Enhancements

Possible improvements for future versions:
- Export to JSON format
- Search/filter captured videos
- Add tags/notes to videos
- Sync across devices via cloud storage
- Import from CSV
- Statistics and insights

## License

This project is open source and available for personal and commercial use.

## Contributing

Feel free to submit issues, fork the repository, and create pull requests for any improvements.
