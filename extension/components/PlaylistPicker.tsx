import { useState, useEffect } from 'react';
import type { Bucket } from '../utils/types';
import type { ScPlaylist } from '../utils/soundcloud-api';
import { sendToBackground } from '../utils/messaging';

interface Props {
  bucket: Bucket;
  isConnected: boolean;
  onLink: (playlistId: string, playlistName: string, playlistUrl: string) => void;
  onUnlink: () => void;
  onBack: () => void;
  onGoToSettings: () => void;
}

export default function PlaylistPicker({ bucket, isConnected, onLink, onUnlink, onBack, onGoToSettings }: Props) {
  const [playlists, setPlaylists] = useState<ScPlaylist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (!isConnected) return;
    setLoading(true);
    sendToBackground<{ playlists?: ScPlaylist[]; error?: string }>({ action: 'fetchScPlaylists' })
      .then((res) => {
        if (res?.error) setError(res.error);
        else setPlaylists(res?.playlists ?? []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [isConnected]);

  async function handleResolveUrl() {
    const url = urlInput.trim();
    if (!url) return;
    setResolving(true);
    setError('');
    const res = await sendToBackground<{ result?: ScPlaylist; error?: string }>({
      action: 'resolveScUrl',
      url,
    });
    setResolving(false);
    if (res?.error) { setError(res.error); return; }
    const p = res?.result as ScPlaylist | undefined;
    if (!p?.id) { setError("Could not resolve URL — make sure it's a playlist link"); return; }
    onLink(String(p.id), p.title, p.permalink_url);
  }

  if (!isConnected) {
    return (
      <div className="view">
        <div className="view-nav">
          <button className="back-btn" onClick={onBack}><ChevronLeft /> {bucket.name}</button>
        </div>
        <div className="empty-state">
          <p>Not connected to SoundCloud.</p>
          <p className="muted">Connect your account in Settings to link playlists.</p>
          <button className="primary-btn" style={{ marginTop: 16, width: 'auto', padding: '8px 20px' }} onClick={onGoToSettings}>
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view">
      <div className="view-nav">
        <button className="back-btn" onClick={onBack}><ChevronLeft /> {bucket.name}</button>
      </div>

      <div className="picker-body">
        {bucket.playlistId && (
          <div className="linked-banner">
            <span className="linked-banner__label">Linked:</span>
            <span className="linked-banner__name">{bucket.playlistName}</span>
            <button className="text-btn text-btn--danger" onClick={onUnlink}>Unlink</button>
          </div>
        )}

        {/* Paste URL fallback */}
        <div className="form" style={{ paddingTop: 10, paddingBottom: 0 }}>
          <label className="form-label">Paste playlist URL</label>
          <div className="folder-row">
            <input
              className="form-input folder-input"
              type="url"
              placeholder="https://soundcloud.com/you/sets/my-playlist"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleResolveUrl()}
            />
            <button className="text-btn browse-btn" onClick={handleResolveUrl} disabled={resolving || !urlInput.trim()}>
              {resolving ? '…' : 'Link'}
            </button>
          </div>
        </div>

        {error && <p className="picker-error">{error}</p>}

        {/* Playlist list from /me/playlists */}
        {loading ? (
          <div className="empty-state"><span className="muted">Loading playlists…</span></div>
        ) : playlists.length > 0 ? (
          <>
            <div className="picker-heading">Your playlists</div>
            <ul className="playlist-list">
              {playlists.map((p) => (
                <li
                  key={p.id}
                  className={`playlist-item${bucket.playlistId === String(p.id) ? ' playlist-item--active' : ''}`}
                  onClick={() => onLink(String(p.id), p.title, p.permalink_url)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && onLink(String(p.id), p.title, p.permalink_url)}
                >
                  <div className="playlist-item__info">
                    <span className="playlist-item__name">{p.title}</span>
                    <span className="playlist-item__count muted">{p.track_count} tracks</span>
                  </div>
                  {bucket.playlistId === String(p.id) && <CheckIcon />}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#44ff88" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}
