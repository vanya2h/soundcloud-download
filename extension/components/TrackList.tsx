import { useState } from 'react';
import type { Bucket, Track } from '../utils/types';

interface Props {
  bucket: Bucket;
  tracks: Track[];
  onBack: () => void;
  onOpenFinder: () => void;
  onRemoveTrack: (track: Track) => void;
}

export default function TrackList({ bucket, tracks, onBack, onOpenFinder, onRemoveTrack }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  function handleRemove(track: Track) {
    setConfirmId(null);
    onRemoveTrack(track);
  }

  return (
    <div className="view">
      <div className="view-nav">
        <button className="back-btn" onClick={onBack}>
          <ChevronLeft /> Buckets
        </button>
        <button className="icon-btn" title="Open in Finder" onClick={onOpenFinder}>
          <FolderIcon />
        </button>
      </div>

      <div className="bucket-header">
        <span className="bucket-header__dot" style={{ background: bucket.color }} />
        <span className="bucket-header__name">{bucket.name}</span>
        <span className="bucket-header__count muted">{tracks.length} tracks</span>
      </div>

      {tracks.length === 0 ? (
        <div className="empty-state">
          <p className="muted">No tracks yet.</p>
        </div>
      ) : (
        <ul className="track-list">
          {tracks.map((t) => (
            <li
              key={t.filename}
              className="track-item"
              onClick={() => { if (confirmId) setConfirmId(null); }}
            >
              <div className="track-item__info">
                <span className="track-item__title">{t.title || stripExt(t.filename)}</span>
                {t.artist && <span className="track-item__artist muted">{t.artist}</span>}
              </div>
              <div className="track-item__actions" onClick={(e) => e.stopPropagation()}>
                {t.url && (
                  <a
                    className="icon-btn"
                    href={t.url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open on SoundCloud"
                  >
                    <ExternalIcon />
                  </a>
                )}
                {confirmId === t.filename ? (
                  <>
                    <button className="icon-btn icon-btn--danger" title="Confirm remove" onClick={() => handleRemove(t)}>
                      <TrashIcon />
                    </button>
                    <button className="icon-btn" title="Cancel" onClick={() => setConfirmId(null)}>✕</button>
                  </>
                ) : (
                  <button className="icon-btn icon-btn--danger" title="Remove from bucket" onClick={() => setConfirmId(t.filename)}>
                    <TrashIcon />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function stripExt(name: string) {
  return name.replace(/\.[^.]+$/, '');
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
    </svg>
  );
}
