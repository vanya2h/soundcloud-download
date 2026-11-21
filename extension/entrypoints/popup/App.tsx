import { useState, useEffect, useCallback } from 'react';
import { storage } from 'wxt/storage';
import type { Bucket, Settings, Track } from '../../utils/types';
import { sendToBackground } from '../../utils/messaging';
import BucketList from '../../components/BucketList';
import TrackList from '../../components/TrackList';
import AddBucketForm from '../../components/AddBucketForm';
import SettingsPanel from '../../components/SettingsPanel';
import PlaylistPicker from '../../components/PlaylistPicker';
import LogsPanel from '../../components/LogsPanel';
import TriageView from '../../components/TriageView';

type View = 'buckets' | 'tracks' | 'add-bucket' | 'settings' | 'playlist-picker' | 'logs' | 'triage';

export default function App() {
  const [view, setView] = useState<View>('buckets');
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [activeBucket, setActiveBucket] = useState<Bucket | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [settings, setSettings] = useState<Settings>({
    rootDir: '', format: 'mp3', quality: 'best', embedArt: true, sc: {},
  });
  const [loading, setLoading] = useState(true);
  const [dlStatus, setDlStatus] = useState<{ total: number; done: number; failed: number }>({ total: 0, done: 0, failed: 0 });
  const [bucketFailures, setBucketFailures] = useState<Record<string, number>>({});

  useEffect(() => {
    const dlStatusItem = storage.defineItem<{ total: number; done: number; failed: number }>('local:dlStatus', { defaultValue: { total: 0, done: 0, failed: 0 } });
    dlStatusItem.getValue().then(setDlStatus);
    return dlStatusItem.watch((v) => setDlStatus(v ?? { total: 0, done: 0, failed: 0 }));
  }, []);

  useEffect(() => {
    const item = storage.defineItem<Record<string, number>>('local:bucketFailures', { defaultValue: {} });
    item.getValue().then(setBucketFailures);
    return item.watch((v) => setBucketFailures(v ?? {}));
  }, []);

  const loadBuckets = useCallback(async () => {
    const res = await sendToBackground<{ buckets: Bucket[] }>({ action: 'getBuckets' });
    setBuckets(res?.buckets ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadBuckets();
    sendToBackground<{ settings: Settings }>({ action: 'getSettings' }).then((res) => {
      if (res?.settings) setSettings(res.settings);
    });
  }, [loadBuckets]);

  async function openBucket(bucket: Bucket) {
    setActiveBucket(bucket);
    setView('tracks');
    setTracks([]);
    const res = await sendToBackground<{ tracks: Track[] }>({ action: 'listTracks', m3uPath: bucket.m3uPath });
    setTracks(res?.tracks ?? []);
  }

  async function removeBucket(id: string) {
    await sendToBackground({ action: 'removeBucket', id });
    loadBuckets();
  }

  async function removeTrack(track: import('../../utils/types').Track) {
    if (!activeBucket) return;
    await sendToBackground({ action: 'removeTrack', bucketId: activeBucket.id, track });
    setTracks((prev) => prev.filter((t) => t.filename !== track.filename));
  }

  async function addBucket(name: string, color: string) {
    const res = await sendToBackground<{ bucket?: Bucket; error?: string }>({ action: 'addBucket', name, color });
    if (res?.error) { alert(res.error); return; }
    await loadBuckets();
    setView('buckets');
  }

  async function saveSettings(s: Settings) {
    setSettings(s);
    await sendToBackground({ action: 'saveSettings', settings: s });
  }

  async function linkPlaylist(bucketId: string, playlistId: string, playlistName: string, playlistUrl: string) {
    await sendToBackground({ action: 'linkPlaylist', bucketId, playlistId, playlistName, playlistUrl });
    await loadBuckets();
    setView('buckets');
  }

  async function unlinkPlaylist(bucketId: string) {
    await sendToBackground({ action: 'unlinkPlaylist', bucketId });
    await loadBuckets();
    setView('buckets');
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header__brand">
          <ScIcon />
          <span className="app-header__title">SoundCloud DL</span>
        </div>
        <button className="icon-btn" title="Sort Likes" onClick={() => setView(view === 'triage' ? 'buckets' : 'triage')}>
          <SortIcon />
        </button>
        <button className="icon-btn" title="Logs" onClick={() => setView(view === 'logs' ? 'buckets' : 'logs')}>
          <LogsIcon />
        </button>
        <button className="icon-btn" title="Settings" onClick={() => setView(view === 'settings' ? 'buckets' : 'settings')}>
          <GearIcon />
        </button>
      </header>

      {dlStatus.total > 0 && (
        <div className="dl-progress">
          <div className="dl-progress__bar">
            <div
              className="dl-progress__fill"
              style={{ width: `${Math.round(((dlStatus.done + dlStatus.failed) / dlStatus.total) * 100)}%` }}
            />
          </div>
          <span className="dl-progress__label">
            {dlStatus.done + dlStatus.failed < dlStatus.total
              ? `↓ ${dlStatus.done + dlStatus.failed} / ${dlStatus.total} `
              : null}
            {dlStatus.done > 0 && <span className="dl-progress__ok">✓{dlStatus.done}</span>}
            {dlStatus.failed > 0 && <span className="dl-progress__fail"> ✗{dlStatus.failed}</span>}
          </span>
        </div>
      )}

      {view === 'buckets' && (
        <BucketList
          buckets={buckets}
          loading={loading}
          rootDir={settings.rootDir}
          bucketFailures={bucketFailures}
          onOpen={openBucket}
          onRemove={removeBucket}
          onOpenFinder={() => sendToBackground({ action: 'openFinder', path: `${settings.rootDir}/library` })}
          onLinkPlaylist={(b) => { setActiveBucket(b); setView('playlist-picker'); }}
          onAdd={() => setView('add-bucket')}
          onGoToSettings={() => setView('settings')}
        />
      )}

      {view === 'tracks' && activeBucket && (
        <TrackList
          bucket={activeBucket}
          tracks={tracks}
          onBack={() => setView('buckets')}
          onOpenFinder={() => sendToBackground({ action: 'openFinder', path: `${settings.rootDir}/library` })}
          onRemoveTrack={removeTrack}
        />
      )}

      {view === 'add-bucket' && (
        <AddBucketForm
          bucketCount={buckets.length}
          rootDir={settings.rootDir}
          onAdd={addBucket}
          onBack={() => setView('buckets')}
          onGoToSettings={() => setView('settings')}
        />
      )}

      {view === 'settings' && (
        <SettingsPanel
          settings={settings}
          onSave={saveSettings}
          onBack={() => setView('buckets')}
        />
      )}

      {view === 'playlist-picker' && activeBucket && (
        <PlaylistPicker
          bucket={activeBucket}
          isConnected={!!settings.sc?.accessToken}
          onLink={(playlistId, playlistName, playlistUrl) =>
            linkPlaylist(activeBucket.id, playlistId, playlistName, playlistUrl)
          }
          onUnlink={() => unlinkPlaylist(activeBucket.id)}
          onBack={() => setView('buckets')}
          onGoToSettings={() => setView('settings')}
        />
      )}

      {view === 'logs' && (
        <LogsPanel onBack={() => setView('buckets')} />
      )}

      {view === 'triage' && (
        <TriageView buckets={buckets} onBack={() => setView('buckets')} onBucketAdded={loadBuckets} />
      )}
    </div>
  );
}

function ScIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="#ff5500">
      <path d="M11.56 8.87V17h8.76c.62-.01 1.12-.49 1.17-1.1.01-.06.01-.12.01-.19V9.59a1.17 1.17 0 00-1.3-1.17c-.48.04-.9.33-1.09.77l-.23.5-.27-.49a3.47 3.47 0 00-6.1-.38l-.95 1.05zm-1.11.57c-.26-.06-.53-.07-.8-.07-.54.01-1.06.15-1.52.41V17h2.32V9.44zM5.63 10.5c-.3-.06-.62-.07-.92-.05C3.17 10.6 2 11.86 2 13.4v.14C2 15.1 3.1 16.4 4.6 16.6c.1.01.21.02.32.02H7.1V10.9a4.5 4.5 0 00-1.47-.4z"/>
    </svg>
  );
}

function SortIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"/>
      <line x1="8" y1="12" x2="16" y2="12"/>
      <line x1="8" y1="18" x2="11" y2="18"/>
      <polyline points="4 6 2 8 4 10"/>
    </svg>
  );
}

function LogsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
      <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </svg>
  );
}
