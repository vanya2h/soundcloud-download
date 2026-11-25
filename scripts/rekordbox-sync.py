#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "pyrekordbox>=0.5.0",
#   "mutagen>=1.47.0",
# ]
# ///
"""
Sync ~/Music/*.m3u bucket playlists into the rekordbox library.

Usage:
    uv run scripts/rekordbox-sync.py [--dry-run] [--music-dir PATH] [--full-audit]

Options:
    --dry-run       Show what would change without writing anything.
    --music-dir     Root directory containing .m3u files and library/. Default: ~/Music
    --full-audit    Force deep path comparison even when track counts match.
    --verbose       Print every import/add action.
"""

import argparse
import os
import sys
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# M3U parsing
# ---------------------------------------------------------------------------

def parse_m3u(path: Path) -> list[str]:
    """Return absolute file paths from an M3U file (skips comment lines)."""
    paths = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                paths.append(line)
    return paths


# ---------------------------------------------------------------------------
# rekordbox helpers (synchronous — no asyncio needed in a script)
# ---------------------------------------------------------------------------

def connect_db(db_dir: Optional[Path] = None):
    try:
        try:
            from pyrekordbox.masterdb import MasterDatabase as _DB
        except ImportError:
            from pyrekordbox import Rekordbox6Database as _DB  # type: ignore[no-redef]
    except ImportError:
        sys.exit(
            "pyrekordbox not found.\n"
            "Run with:  uv run scripts/rekordbox-sync.py\n"
            "Or activate the rekordbox-mcp venv first."
        )

    if db_dir:
        db = _DB(db_dir=str(db_dir))
    else:
        # auto-detect (macOS)
        default = Path.home() / "Library" / "Pioneer"
        db = _DB(db_dir=str(default))

    return db


def get_all_content(db) -> dict[str, object]:
    """Return {FolderPath: content_row} for all active tracks."""
    result = {}
    for c in db.get_content():
        if getattr(c, "rb_local_deleted", 0):
            continue
        fp = getattr(c, "FolderPath", "") or ""
        if fp:
            result[fp] = c
    return result


def get_playlists(db) -> dict[str, object]:
    """Return {name: playlist_row} for all active non-folder playlists."""
    result = {}
    for p in db.get_playlist():
        if getattr(p, "rb_local_deleted", 0):
            continue
        is_folder = getattr(p, "is_folder", False) or (
            getattr(p, "Attribute", 0) == 1
        )
        if not is_folder:
            result[p.Name] = p
    return result


def get_playlist_paths(db, playlist_id: int, content_by_id: dict[int, object]) -> set[str]:
    """Return the set of FolderPaths currently in a playlist."""
    paths = set()
    for song in db.get_playlist_songs(PlaylistID=playlist_id):
        if getattr(song, "rb_local_deleted", 0):
            continue
        content = content_by_id.get(song.ContentID)
        if content:
            fp = getattr(content, "FolderPath", "") or ""
            if fp:
                paths.add(fp)
    return paths


def read_audio_tags(path: Path) -> dict:
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(str(path), easy=True)
    except Exception:
        return {}
    if audio is None:
        return {}

    def first(key):
        val = audio.get(key)
        if not val:
            return None
        return val[0] if isinstance(val, list) else str(val)

    tags: dict = {}
    for src, dst in [("title", "title"), ("artist", "artist"), ("album", "album"),
                     ("genre", "genre")]:
        v = first(src)
        if v:
            tags[dst] = v

    bpm_raw = first("bpm")
    if bpm_raw:
        try:
            tags["bpm"] = float(bpm_raw)
        except ValueError:
            pass

    year_raw = first("date") or first("year")
    if year_raw:
        try:
            tags["year"] = int(str(year_raw)[:4])
        except ValueError:
            pass

    info = getattr(audio, "info", None)
    if info:
        if getattr(info, "length", None):
            tags["length"] = int(info.length)
        if getattr(info, "bitrate", None):
            tags["bitrate"] = (
                int(info.bitrate // 1000) if info.bitrate > 10000 else int(info.bitrate)
            )
        if getattr(info, "sample_rate", None):
            tags["sample_rate"] = int(info.sample_rate)

    return tags


def resolve_or_create(db, getter, adder, name: str):
    if not name or not name.strip():
        return None
    clean = name.strip()
    try:
        existing = getattr(db, getter)(Name=clean)
        row = existing.first() if hasattr(existing, "first") else next(iter(existing), None)
        if row is not None:
            return row
    except Exception:
        pass
    try:
        return getattr(db, adder)(clean)
    except Exception:
        return None


def import_track(db, path: str, content_by_path: dict) -> Optional[int]:
    """
    Import a track if not already in the library.
    Returns the track ID (int), or None on error.
    """
    file_path = Path(path).expanduser()
    if not file_path.is_file():
        print(f"  [MISSING FILE] {path}", file=sys.stderr)
        return None

    # Already imported?
    existing = content_by_path.get(str(file_path))
    if existing:
        return existing.ID

    tags = read_audio_tags(file_path)
    kwargs: dict = {}

    if tags.get("title"):
        kwargs["Title"] = tags["title"].strip()

    artist_row = None
    if tags.get("artist"):
        artist_row = resolve_or_create(db, "get_artist", "add_artist", tags["artist"])
        if artist_row:
            kwargs["ArtistID"] = artist_row.ID

    if tags.get("genre"):
        genre_row = resolve_or_create(db, "get_genre", "add_genre", tags["genre"])
        if genre_row:
            kwargs["GenreID"] = genre_row.ID

    if tags.get("bpm") is not None:
        kwargs["BPM"] = int(round(float(tags["bpm"]) * 100))
    if tags.get("length") is not None:
        kwargs["Length"] = int(tags["length"])
    if tags.get("bitrate") is not None:
        kwargs["BitRate"] = int(tags["bitrate"])
    if tags.get("sample_rate") is not None:
        kwargs["SampleRate"] = int(tags["sample_rate"])

    try:
        content = db.add_content(str(file_path), **kwargs)
        content_by_path[str(file_path)] = content
        return content.ID
    except ValueError as e:
        msg = str(e).lower()
        if "already exists" in msg:
            # Race / stale cache — scan by path
            for c in db.get_content():
                if getattr(c, "FolderPath", "") == str(file_path):
                    content_by_path[str(file_path)] = c
                    return c.ID
        print(f"  [IMPORT ERROR] {file_path.name}: {e}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  [IMPORT ERROR] {file_path.name}: {e}", file=sys.stderr)
        return None


# ---------------------------------------------------------------------------
# Main sync logic
# ---------------------------------------------------------------------------

def sync(music_dir: Path, dry_run: bool, full_audit: bool, verbose: bool) -> None:
    # --- Discover M3U files ---
    m3u_files = sorted(music_dir.glob("*.m3u"))
    if not m3u_files:
        sys.exit(f"No .m3u files found in {music_dir}")

    buckets: dict[str, list[str]] = {}
    for m3u in m3u_files:
        name = m3u.stem
        paths = parse_m3u(m3u)
        if paths:
            buckets[name] = paths

    print(f"Found {len(buckets)} M3U buckets, {sum(len(v) for v in buckets.values())} total entries")

    # --- Connect ---
    print("Connecting to rekordbox database…")
    db = connect_db()

    # --- Read current state ---
    content_by_path = get_all_content(db)
    content_by_id: dict[int, object] = {
        c.ID: c for c in content_by_path.values()
    }
    rb_playlists = get_playlists(db)

    print(f"Library: {len(content_by_path)} tracks, {len(rb_playlists)} playlists")

    # --- Diff ---
    new_playlist_names: list[str] = []
    updates: dict[str, list[str]] = {}  # playlist_name → missing paths

    for bucket_name, m3u_paths in buckets.items():
        m3u_set = set(m3u_paths)

        if bucket_name not in rb_playlists:
            new_playlist_names.append(bucket_name)
            updates[bucket_name] = m3u_paths
            continue

        playlist = rb_playlists[bucket_name]
        rb_count = sum(
            1 for s in db.get_playlist_songs(PlaylistID=playlist.ID)
            if not getattr(s, "rb_local_deleted", 0)
        )

        if rb_count == len(m3u_paths) and not full_audit:
            if verbose:
                print(f"  {bucket_name}: in sync ({rb_count} tracks)")
            continue

        # Deep path comparison
        rb_paths = get_playlist_paths(db, playlist.ID, content_by_id)
        missing = [p for p in m3u_paths if p not in rb_paths]
        if missing:
            updates[bucket_name] = missing

    # --- Report plan ---
    total_missing = sum(len(v) for v in updates.values())
    print(f"\nPlan: {len(new_playlist_names)} new playlists, {total_missing} tracks to add")
    for name in new_playlist_names:
        print(f"  + CREATE playlist '{name}' ({len(updates[name])} tracks)")
    for name, paths in updates.items():
        if name not in new_playlist_names:
            print(f"  ~ UPDATE '{name}': +{len(paths)} tracks")

    if total_missing == 0 and not new_playlist_names:
        print("Everything in sync.")
        return

    if dry_run:
        print("\n[dry-run] No changes written.")
        return

    # --- Apply ---
    # Create new playlists
    playlist_id_map: dict[str, int] = {
        name: playlist.ID for name, playlist in rb_playlists.items()
    }
    for name in new_playlist_names:
        try:
            p = db.create_playlist(name=name)
            pid = p.ID if hasattr(p, "ID") else int(p)
            playlist_id_map[name] = pid
            db.commit()
            print(f"  Created playlist '{name}' (id={pid})")
        except Exception as e:
            print(f"  [ERROR] create playlist '{name}': {e}", file=sys.stderr)

    # Import tracks and add to playlists
    total_imported = 0
    total_added = 0

    for bucket_name, missing_paths in updates.items():
        pid = playlist_id_map.get(bucket_name)
        if pid is None:
            print(f"  [SKIP] No playlist ID for '{bucket_name}'", file=sys.stderr)
            continue

        track_ids_to_add: list[int] = []
        imported_count = 0

        for path in missing_paths:
            already_in_lib = str(Path(path).expanduser()) in content_by_path
            tid = import_track(db, path, content_by_path)
            if tid is None:
                continue
            track_ids_to_add.append(tid)
            if not already_in_lib:
                imported_count += 1
                if verbose:
                    print(f"    imported {Path(path).name}")

        db.commit()

        # Add to playlist
        added = 0
        for tid in track_ids_to_add:
            try:
                db.add_to_playlist(pid, tid)
                added += 1
                if verbose:
                    print(f"    → added track {tid} to '{bucket_name}'")
            except Exception as e:
                if verbose:
                    print(f"    [WARN] add track {tid}: {e}", file=sys.stderr)

        if added:
            db.commit()

        total_imported += imported_count
        total_added += added
        print(f"  {bucket_name}: +{added} tracks ({imported_count} new imports)")

    print(f"\nDone. {total_imported} tracks imported to library, {total_added} playlist entries added.")
    print("Open rekordbox and run Analyze Tracks to generate waveforms/beatgrids.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Sync M3U buckets → rekordbox")
    parser.add_argument(
        "--music-dir",
        type=Path,
        default=Path.home() / "Music",
        help="Directory containing .m3u files (default: ~/Music)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would change without writing to the database",
    )
    parser.add_argument(
        "--full-audit",
        action="store_true",
        help="Deep-compare all playlists even when track counts match",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Print each import/add action",
    )
    args = parser.parse_args()

    if not args.music_dir.is_dir():
        sys.exit(f"Music directory not found: {args.music_dir}")

    sync(
        music_dir=args.music_dir,
        dry_run=args.dry_run,
        full_audit=args.full_audit,
        verbose=args.verbose,
    )


if __name__ == "__main__":
    main()
