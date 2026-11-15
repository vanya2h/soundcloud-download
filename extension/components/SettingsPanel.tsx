import { useState, useEffect } from 'react';
import type { Settings } from '../utils/types';
import { sendToBackground } from '../utils/messaging';

interface Props {
  settings: Settings;
  onSave: (s: Settings) => void;
  onBack: () => void;
}

type DepStatus = 'checking' | 'ok' | 'missing';
type ConnectStatus = 'idle' | 'connecting' | 'error';

export default function SettingsPanel({ settings, onSave, onBack }: Props) {
  const [local, setLocal] = useState<Settings>(settings);
  const [ytdlp, setYtdlp] = useState<DepStatus>('checking');
  const [ffmpeg, setFfmpeg] = useState<DepStatus>('checking');
  const [pickPending, setPickPending] = useState(false);
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>('idle');
  const [connectError, setConnectError] = useState('');
  const redirectUrl = 'http://127.0.0.1:8765/';
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    sendToBackground<{ path: string | null }>({ action: 'consumePendingFolderPick' }).then((res) => {
      if (res?.path) {
        const next = { ...local, rootDir: res.path };
        setLocal(next);
        onSave(next);
        setPickPending(false);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sendToBackground<{ ytdlp: boolean; ffmpeg: boolean }>({ action: 'checkDeps' })
      .then((res) => {
        setYtdlp(res?.ytdlp ? 'ok' : 'missing');
        setFfmpeg(res?.ffmpeg ? 'ok' : 'missing');
      })
      .catch(() => { setYtdlp('missing'); setFfmpeg('missing'); });
  }, []);

  function update<K extends keyof Settings>(key: K, val: Settings[K]) {
    const next = { ...local, [key]: val };
    setLocal(next);
    onSave(next);
  }

  function updateSc(key: keyof Settings['sc'], val: string) {
    const next = { ...local, sc: { ...local.sc, [key]: val } };
    setLocal(next);
    onSave(next);
  }

  async function browseRootDir() {
    setPickPending(true);
    sendToBackground<{ path?: string; error?: string }>({ action: 'pickFolder' }).then((res) => {
      if (res?.path) { update('rootDir', res.path); setPickPending(false); }
      else if (res?.error) setPickPending(false);
    });
  }

  function copyRedirectUrl() {
    navigator.clipboard.writeText(redirectUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  async function handleConnect() {
    setConnectStatus('connecting');
    setConnectError('');
    const res = await sendToBackground<{ username?: string; error?: string }>({ action: 'connectSoundCloud' });
    if (res?.error) { setConnectStatus('error'); setConnectError(res.error); }
    else {
      setConnectStatus('idle');
      // Refresh local settings to show new username
      const fresh = await sendToBackground<{ settings: Settings }>({ action: 'getSettings' });
      if (fresh?.settings) { setLocal(fresh.settings); onSave(fresh.settings); }
    }
  }

  async function handleDisconnect() {
    await sendToBackground({ action: 'disconnectSoundCloud' });
    const fresh = await sendToBackground<{ settings: Settings }>({ action: 'getSettings' });
    if (fresh?.settings) { setLocal(fresh.settings); onSave(fresh.settings); }
  }

  const isConnected = !!local.sc?.accessToken;

  return (
    <div className="view">
      <div className="view-nav">
        <button className="back-btn" onClick={onBack}><ChevronLeft /> Back</button>
      </div>

      <div className="form">
        {pickPending && (
          <div className="pick-hint">Select a folder in the dialog, then reopen this popup.</div>
        )}

        <label className="form-label">Root directory</label>
        <div className="folder-row">
          <input
            className="form-input folder-input"
            type="text"
            placeholder="/Users/you/Music/DJ"
            value={local.rootDir}
            onChange={(e) => update('rootDir', e.target.value)}
          />
          <button type="button" className="text-btn browse-btn" onClick={browseRootDir} disabled={pickPending}>
            {pickPending ? '…' : 'Browse'}
          </button>
        </div>
        {local.rootDir && !pickPending && (
          <p className="form-hint">New buckets will be created as subfolders here.</p>
        )}

        <label className="form-label">Format</label>
        <select className="form-select" value={local.format} onChange={(e) => update('format', e.target.value as Settings['format'])}>
          <option value="mp3">MP3</option>
          <option value="aiff">AIFF</option>
          <option value="wav">WAV</option>
          <option value="flac">FLAC</option>
          <option value="m4a">M4A</option>
        </select>

        <label className="form-label">Quality</label>
        <select className="form-select" value={local.quality} onChange={(e) => update('quality', e.target.value as Settings['quality'])}>
          <option value="best">Best available</option>
          <option value="320">320 kbps</option>
          <option value="256">256 kbps</option>
          <option value="192">192 kbps</option>
          <option value="128">128 kbps</option>
        </select>

        <label className="toggle-label">
          <span className="form-label" style={{ marginBottom: 0 }}>Embed artwork</span>
          <label className="toggle">
            <input type="checkbox" checked={local.embedArt} onChange={(e) => update('embedArt', e.target.checked)} />
            <span className="toggle-slider" />
          </label>
        </label>

        {/* SoundCloud connection */}
        <div className="sc-auth-section">
          <div className="deps-title">SoundCloud API</div>

          <label className="form-label">Client ID</label>
          <input
            className="form-input"
            type="text"
            placeholder="your_client_id"
            value={local.sc?.clientId ?? ''}
            onChange={(e) => updateSc('clientId', e.target.value)}
          />

          <label className="form-label">Client Secret</label>
          <input
            className="form-input"
            type="password"
            placeholder="your_client_secret"
            value={local.sc?.clientSecret ?? ''}
            onChange={(e) => updateSc('clientSecret', e.target.value)}
          />

          <label className="form-label">Redirect URL</label>
          <div className="redirect-url-row">
            <span className="redirect-url-value" title={redirectUrl}>{redirectUrl}</span>
            <button type="button" className="text-btn" onClick={copyRedirectUrl}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="form-hint">Add this exact URL to your SoundCloud app's redirect URIs on <a href="https://soundcloud.com/you/apps" target="_blank" rel="noreferrer" className="form-hint__link">soundcloud.com/you/apps</a>. Auth opens in your system browser — the popup can stay open.</p>

          {isConnected ? (
            <div className="sc-connected">
              <span className="sc-connected__user">✓ Connected as <strong>{local.sc?.username}</strong></span>
              <button className="text-btn text-btn--danger" onClick={handleDisconnect}>Disconnect</button>
            </div>
          ) : (
            <>
              <button
                className="primary-btn"
                onClick={handleConnect}
                disabled={connectStatus === 'connecting' || !local.sc?.clientId || !local.sc?.clientSecret}
              >
                {connectStatus === 'connecting' ? 'Connecting…' : 'Connect SoundCloud'}
              </button>
              {connectError && <p className="picker-error">{connectError}</p>}
            </>
          )}
        </div>

        <div className="deps-section">
          <div className="deps-title">Dependencies</div>
          <DepRow label="yt-dlp" status={ytdlp} />
          <DepRow label="ffmpeg" status={ffmpeg} />
        </div>
      </div>
    </div>
  );
}

function DepRow({ label, status }: { label: string; status: DepStatus }) {
  return (
    <div className="dep-row">
      <span className="dep-name">{label}</span>
      <span className={`dep-status dep-status--${status}`}>
        {status === 'checking' ? '…' : status === 'ok' ? '✓ installed' : '✗ missing'}
      </span>
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
