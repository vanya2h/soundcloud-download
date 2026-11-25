---
name: rekordbox-sync
description: Sync SoundCloud DL extension buckets (M3U playlists) into rekordbox. Creates missing playlists, imports new tracks, and adds them to the right playlists. Use when the user has downloaded new tracks via the extension and wants to push the changes into rekordbox.
---

# Rekordbox Sync

Run the sync script. That's it.

## Steps

1. **Dry-run first** — show the user what will change without touching the DB:

```bash
uv run /Users/vanya2h/Repos/soundcloud-dl/scripts/rekordbox-sync.py --dry-run
```

2. **Confirm rekordbox is closed**, then apply:

```bash
uv run /Users/vanya2h/Repos/soundcloud-dl/scripts/rekordbox-sync.py
```

If the script exits with "Rekordbox is running", ask the user to close it and re-run.

3. **Report** the script's output to the user and remind them to open rekordbox and run **Analyze Tracks** to generate waveforms and beatgrids for newly imported files.

## Flags

| Flag | When to use |
|---|---|
| `--dry-run` | Always run first to preview changes |
| `--full-audit` | User asks for a deep check even when counts look in sync |
| `--verbose` | User wants to see each individual import/add |
| `--music-dir PATH` | Music root is not `~/Music` |
