# SoundCloud DL

A Chrome extension for DJs that downloads SoundCloud tracks into organized genre folders ("buckets") and keeps them in sync with your rekordbox library.

**Stack:** WXT + React 18 (extension) · Node.js ESM (native host) · yt-dlp + ffmpeg (audio)

---

## Features

- **Buckets** — create genre folders; each bucket maps to a directory on disk and an M3U playlist file
- **One-click download** — a download button appears on every SoundCloud track page; pick a bucket and the file lands in the right folder with metadata and embedded artwork
- **SC playlist sync** — link a bucket to any SoundCloud playlist and pull new tracks automatically
- **Triage view** — browse your SC likes one track at a time (with preview playback), route each one to a bucket or dismiss it
- **Track list** — see every downloaded track in a bucket, open the folder in Finder, jump back to the SC page, or remove a track
- **Format & quality control** — choose mp3 / aiff / wav / flac / m4a and bitrate before downloading
- **rekordbox sync** — a Claude Code skill (`/rekordbox-sync`) that pushes all your buckets into rekordbox as playlists

---

## Requirements

| Tool | Install |
|---|---|
| Node.js ≥ 18 | https://nodejs.org |
| pnpm ≥ 9 | `npm i -g pnpm` |
| yt-dlp | `brew install yt-dlp` |
| ffmpeg | `brew install ffmpeg` |

> macOS only. The native host uses macOS-specific Native Messaging paths. Linux support is possible with minor path changes in `host/install.sh`.

---

## Installation

### 1. Clone and build

```bash
git clone https://github.com/YOUR_USERNAME/soundcloud-dl.git
cd soundcloud-dl
pnpm install
pnpm build
```

This builds the extension into `extension/.output/chrome-mv3/`.

### 2. Load the extension

1. Open `chrome://extensions` (or `dia://extensions`, `brave://extensions`, etc.)
2. Enable **Developer mode**
3. Click **Load unpacked** → select `extension/.output/chrome-mv3/`
4. Copy the **Extension ID** shown on the card (you'll need it in the next step)

### 3. Install the native host

The native host is a Node.js process that the extension spawns to run yt-dlp downloads. It must be registered with your browser via Native Messaging.

```bash
bash host/install.sh <your-extension-id>
```

The script:
- Checks that `node`, `yt-dlp`, and `ffmpeg` are on your PATH
- Writes a wrapper script (`host/run.sh`) with the absolute path to your Node binary
- Registers the host manifest in every Chromium-based browser it finds (Chrome, Brave, Arc, Dia, Edge, Chromium)

If you use the extension in multiple browsers, run the script once per browser ID:

```bash
bash host/install.sh <chrome-id> <brave-id>
```

### 4. Verify

- Open any SoundCloud track page
- A **DL** button should appear in the player bar
- Click it, pick a bucket, watch it download

---

## First-time setup

### Set a root directory

Open the extension popup → **Settings** → click the folder icon next to **Root directory**. All buckets will be created as subdirectories here.

### Add a bucket

Click **+ Add** in the main view. Give it a name (e.g. "Trance") and pick a colour. The bucket creates:
- A folder: `<rootDir>/Trance/`
- A playlist file: `<rootDir>/Trance.m3u`

### Download a track

Browse SoundCloud normally. Each track page shows a **DL** button in the player. Click it, choose a bucket, and the file downloads in the background. Progress shows in the extension popup.

---

## SoundCloud playlist sync (optional)

To automatically pull all tracks from a SC playlist into a bucket:

1. Open the extension popup
2. Click the link icon on a bucket → **Link playlist**
3. Sign in with SoundCloud OAuth (see below)
4. Pick a playlist from your account
5. Click the **sync** button (↻) to pull new tracks

The sync is incremental — already-downloaded tracks are skipped.

### SoundCloud OAuth setup

The extension uses the SC API to fetch playlists and liked tracks. You need API credentials:

1. Go to [SoundCloud for Developers](https://soundcloud.com/you/apps) → **Register a new app**
2. Set the redirect URI to `http://127.0.0.1:8765/`
3. Copy the **Client ID** and **Client Secret**
4. Paste them into the extension popup → **Settings** → **SoundCloud**
5. Click **Connect** — this opens an OAuth flow in a new tab

> The access token is stored locally in Chrome's extension storage and never sent anywhere except the SoundCloud API.

---

## Triage view

The triage view lets you quickly process your SC likes:

1. Click the **Triage** button in the popup
2. Each liked track is shown one at a time with title, artist, genre, and tags
3. Click the **play** button to preview the track
4. Click a bucket name to download the track into that bucket (it disappears from the queue)
5. Click **Skip** (→) to dismiss the track without downloading

Triage requires SoundCloud OAuth to be connected.

---

## rekordbox sync (Claude Code skill)

If you use rekordbox, the included Claude Code skill keeps your rekordbox playlists in sync with your M3U bucket files.

### Requirements

- [Claude Code](https://claude.ai/code) installed
- [rekordbox MCP server](https://github.com/YOUR_USERNAME/rekordbox-mcp) installed and configured

### Usage

After downloading new tracks via the extension, open Claude Code in this repo directory and run:

```
/rekordbox-sync
```

The skill will:
1. Connect to your rekordbox database
2. Read all `~/Music/*.m3u` files
3. Create any rekordbox playlists that don't exist yet
4. Import any tracks not already in the rekordbox library
5. Add missing tracks to their playlists

> **Important:** rekordbox must be **closed** when the skill writes to the database. The skill will tell you if it's running.

After sync, open rekordbox and run **Analyze Tracks** (right-click → Analyze) to generate waveforms, beatgrids, and key analysis for the newly imported files.

---

## Project structure

```
soundcloud-dl/
├── extension/              # WXT + React Chrome extension
│   ├── components/         # UI components
│   ├── entrypoints/
│   │   ├── background.ts   # Service worker — storage, downloads, SC API calls
│   │   ├── popup/          # Extension popup (React app)
│   │   └── soundcloud.content/  # Content script injected on soundcloud.com
│   ├── utils/
│   │   ├── types.ts        # Shared TypeScript types and message definitions
│   │   ├── messaging.ts    # Type-safe extension messaging helpers
│   │   └── soundcloud-api.ts    # SoundCloud REST API client
│   └── wxt.config.ts
├── host/                   # Native messaging host
│   ├── index.js            # Main host process (download, M3U read/write, folder picker)
│   ├── install.sh          # Installer — registers host with all detected Chromium browsers
│   └── com.soundclouddl.host.json  # Manifest template
├── scripts/
│   └── generate-icons.js   # Generates PNG icons from scratch (no deps)
└── .claude/
    └── skills/
        └── rekordbox-sync/ # Claude Code skill for rekordbox sync
```

---

## Development

```bash
# Start extension in dev mode (hot reload)
pnpm dev

# Build for production
pnpm build

# Regenerate icons
pnpm icons
```

After `pnpm dev` starts, reload the unpacked extension in your browser. Changes to React components hot-reload automatically; changes to the background service worker require a manual extension reload.

---

## How downloads work

1. The content script on `soundcloud.com` injects a **DL** button into the player
2. Clicking it sends a message to the background service worker with the track URL and metadata
3. The background opens a Native Messaging port to `host/index.js`
4. The host spawns `yt-dlp` as a child process, streaming progress back over stdout
5. Progress events are forwarded to the popup via `chrome.tabs.sendMessage`
6. On completion, the host appends an `#EXTINF` + `#SCURL` entry to the bucket's `.m3u` file

The `.m3u` format used:

```
#EXTM3U
#EXTINF:240,Artist - Title
#SCURL:https://soundcloud.com/artist/title
/path/to/music/library/Artist - Title.mp3
```

The `#SCURL` line enables bidirectional sync — the extension can match a SC track to a local file by URL.

---

## License

MIT — see [LICENSE](LICENSE).
