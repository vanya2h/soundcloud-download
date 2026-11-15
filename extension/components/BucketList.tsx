import { useState } from 'react';
import type { Bucket } from '../utils/types';
import { sendToBackground } from '../utils/messaging';

interface Props {
  buckets: Bucket[];
  loading: boolean;
  rootDir: string;
  onOpen: (b: Bucket) => void;
  onRemove: (id: string) => void;
  onOpenFinder: (b: Bucket) => void;
  onLinkPlaylist: (b: Bucket) => void;
  onAdd: () => void;
  onGoToSettings: () => void;
}

export default function BucketList({ buckets, loading, rootDir, onOpen, onRemove, onOpenFinder, onLinkPlaylist, onAdd, onGoToSettings }: Props) {
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncAllResult, setSyncAllResult] = useState<number | null>(null);

  const linkedBuckets = buckets.filter((b) => b.playlistId);

  async function handleSyncAll() {
    if (syncingAll || linkedBuckets.length === 0) return;
    setSyncingAll(true);
    setSyncAllResult(null);
    const results = await Promise.all(
      linkedBuckets.map((b) =>
        sendToBackground<{ queued?: number; error?: string }>({ action: 'syncBucket', bucketId: b.id })
      )
    );
    const totalQueued = results.reduce((sum, r) => sum + (r?.queued ?? 0), 0);
    setSyncingAll(false);
    setSyncAllResult(totalQueued);
    setTimeout(() => setSyncAllResult(null), 3000);
  }

  return (
    <div className="view">
      {!rootDir && (
        <div className="banner">
          <span>Set a root directory to start</span>
          <button className="text-btn" onClick={onGoToSettings}>Settings →</button>
        </div>
      )}
      <div className="section-header">
        <span className="section-title">Buckets</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {linkedBuckets.length > 0 && (
            <button
              className={`sync-btn${syncingAll ? ' sync-btn--spinning' : ''}`}
              title="Sync all linked playlists"
              onClick={handleSyncAll}
              disabled={syncingAll}
              style={{ width: 'auto', padding: '0 8px', gap: 4, fontSize: 11 }}
            >
              <SyncIcon />
              {syncAllResult !== null ? `+${syncAllResult} new` : 'Sync all'}
            </button>
          )}
          <button className="text-btn" onClick={onAdd}>+ Add</button>
        </div>
      </div>

      {loading ? (
        <div className="empty-state"><span className="muted">Loading…</span></div>
      ) : buckets.length === 0 ? (
        <div className="empty-state">
          <p>No buckets yet.</p>
          <p className="muted">Add a folder to start organizing your downloads.</p>
        </div>
      ) : (
        <ul className="bucket-list">
          {buckets.map((b) => (
            <BucketItem
              key={b.id}
              bucket={b}
              onOpen={() => onOpen(b)}
              onRemove={() => onRemove(b.id)}
              onOpenFinder={() => onOpenFinder(b)}
              onLinkPlaylist={() => onLinkPlaylist(b)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function BucketItem({ bucket, onOpen, onRemove, onOpenFinder, onLinkPlaylist }: {
  bucket: Bucket;
  onOpen: () => void;
  onRemove: () => void;
  onOpenFinder: () => void;
  onLinkPlaylist: () => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ queued: number; skipped: number } | null>(null);
  const [syncError, setSyncError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function handleSync(e: React.MouseEvent, reset = false) {
    e.stopPropagation();
    setSyncing(true);
    setSyncResult(null);
    setSyncError('');
    const res = await sendToBackground<{ queued?: number; skipped?: number; error?: string }>({
      action: reset ? 'resetBucketSync' : 'syncBucket',
      bucketId: bucket.id,
    });
    setSyncing(false);
    if (res?.error) { setSyncError(res.error); return; }
    setSyncResult({ queued: res?.queued ?? 0, skipped: res?.skipped ?? 0 });
    setTimeout(() => setSyncResult(null), 4000);
  }

  return (
    <li className="bucket-item" onClick={onOpen} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <span className="bucket-item__dot" style={{ background: bucket.color }} />
      <div className="bucket-item__body">
        <div className="bucket-item__row">
          <span className="bucket-item__name">{bucket.name}</span>
          <span className="bucket-item__path" title={bucket.m3uPath}>{shortPath(bucket.m3uPath)}</span>
        </div>

        {bucket.playlistId && (
          <div onClick={(e) => e.stopPropagation()}>
            <div className="bucket-item__sync">
              <LinkIcon />
              <span className="bucket-item__playlist-name">{bucket.playlistName}</span>
              {bucket.lastSyncedAt && (
                <span className="muted bucket-item__last-sync">{relativeTime(bucket.lastSyncedAt)}</span>
              )}
              <button
                className={`sync-btn${syncing ? ' sync-btn--spinning' : ''}`}
                title="Sync new tracks"
                onClick={(e) => handleSync(e, false)}
                disabled={syncing}
              >
                <SyncIcon />
              </button>
              <button
                className="sync-btn sync-btn--reset"
                title="Re-download all (clears history)"
                onClick={(e) => handleSync(e, true)}
                disabled={syncing}
              >
                <ResetIcon />
              </button>
              {syncResult != null && (
                <span className="sync-result">
                  {syncResult.queued > 0 ? `+${syncResult.queued} queued` : 'Up to date'}
                </span>
              )}
            </div>
            {syncError && <div className="sync-error">⚠ {syncError}</div>}
          </div>
        )}
      </div>

      <div className="bucket-item__actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title={bucket.playlistId ? 'Change playlist' : 'Link playlist'} onClick={onLinkPlaylist}>
          <LinkIcon />
        </button>
        <button className="icon-btn" title="Open in Finder" onClick={onOpenFinder}>
          <FolderIcon />
        </button>
        {confirmRemove ? (
          <>
            <button className="icon-btn icon-btn--danger" title="Confirm remove" onClick={() => { setConfirmRemove(false); onRemove(); }}>
              <TrashIcon />
            </button>
            <button className="icon-btn" title="Cancel" onClick={() => setConfirmRemove(false)}>✕</button>
          </>
        ) : (
          <button className="icon-btn icon-btn--danger" title="Remove bucket" onClick={() => setConfirmRemove(true)}>
            <TrashIcon />
          </button>
        )}
      </div>
    </li>
  );
}

function shortPath(p: string | undefined) {
  return (p ?? '').replace(/^\/Users\/[^/]+/, '~');
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/>
      <path d="M3 3v5h5"/>
    </svg>
  );
}

function SyncIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10"/>
      <polyline points="1 20 1 14 7 14"/>
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
    </svg>
  );
}
