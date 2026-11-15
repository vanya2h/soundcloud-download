---
name: rekordbox-sync
description: Sync SoundCloud DL extension buckets (M3U playlists) into rekordbox. Creates missing playlists, imports new tracks, and adds them to the right playlists. Use when the user has downloaded new tracks via the extension and wants to push the changes into rekordbox.
---

# Rekordbox Sync

Sync the local M3U bucket files from the SoundCloud DL extension into rekordbox — creating new playlists, importing new tracks, and filling in any gaps.

## Overview

The SoundCloud DL extension maintains one `.m3u` file per bucket under `~/Music/`. Rekordbox is the source of truth for playback. This skill keeps them in sync: every track in every M3U should exist in rekordbox's library **and** be a member of the matching rekordbox playlist.

## Prerequisites

- rekordbox MCP server installed and configured
- rekordbox must be **closed** before any write operations (imports, playlist changes)
- Audio files live under `~/Music/library/`
- M3U files live under `~/Music/*.m3u`

## Workflow

### Step 1 — Connect and read current state (parallel)

```
mcp__rekordbox__connect_database()
mcp__rekordbox__get_playlists()
find ~/Music -name "*.m3u" → read all files
```

Parse each M3U: extract file paths (lines not starting with `#`). Build a map of `bucketName → [filePaths]`.

### Step 2 — Diff M3U vs rekordbox

Compare bucket names to playlist names (case-sensitive, exact match). Identify:
- **New playlists**: buckets with no matching rekordbox playlist → `create_playlist(name)`
- **Existing playlists with missing tracks**: M3U has more entries than the playlist's `track_count`, or file paths not present in `get_playlist_tracks()` results

For playlists where `track_count` matches the M3U entry count, they are likely in sync — skip the deep comparison unless the user asks for a full audit.

### Step 3 — Import all missing tracks (parallel)

For every file path that needs to be added to any playlist, call `import_track(path)`. Fire all imports in parallel — `import_track` is idempotent (returns `status: "skipped"` with the existing `track_id` if already in library).

Collect the `track_id` from each result (whether `success` or `skipped`). For skipped tracks, use `search_tracks_by_filename(filename)` to retrieve the ID if needed.

### Step 4 — Add tracks to playlists (parallel)

Once all track IDs are known, call `add_tracks_to_playlist(playlist_id, track_ids)` for each playlist that needs updating. Fire all in parallel.

**If rekordbox is running**, all write calls will fail with "Rekordbox is running". Ask the user to close it, then retry the same calls.

### Step 5 — Confirm

Report a table: playlist name, tracks added, new vs existing. Remind the user to open rekordbox and run **Analyze Tracks** to generate waveforms and beatgrids for newly imported files.

## Key details

- M3U format: `#EXTINF:duration,display_name` → optional `#SCURL:url` → absolute file path. The file path line is what matters.
- Filenames on disk often contain special characters (Cyrillic, Unicode symbols, full-width colons `：`, special slashes `⧸`). Use the exact path from the M3U — it reflects the actual filename.
- One track can appear in multiple M3U files (e.g. a track in both Trance and Heavenly). `import_track` handles this gracefully; just add the same `track_id` to multiple playlists.
- After sync, remind the user to analyze tracks in rekordbox for BPM/key/waveform data.

## Music root

`~/Music/` — M3U files at root, audio files under `library/`.
