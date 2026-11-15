import { useState } from 'react';
import { BUCKET_COLORS } from '../utils/types';

interface Props {
  bucketCount: number;
  rootDir: string;
  onAdd: (name: string, color: string) => void;
  onBack: () => void;
  onGoToSettings: () => void;
}

export default function AddBucketForm({ bucketCount, rootDir, onAdd, onBack, onGoToSettings }: Props) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(BUCKET_COLORS[bucketCount % BUCKET_COLORS.length]);

  const canAdd = name.trim().length > 0 && rootDir.length > 0;
  const previewM3u = rootDir && name.trim() ? `${rootDir}/${name.trim()}.m3u` : null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canAdd) return;
    onAdd(name.trim(), color);
  }

  if (!rootDir) {
    return (
      <div className="view">
        <div className="view-nav">
          <button className="back-btn" onClick={onBack}>
            <ChevronLeft /> Buckets
          </button>
        </div>
        <div className="empty-state">
          <p>No root directory set.</p>
          <p className="muted">Set a root directory in Settings first — buckets will be created as subfolders inside it.</p>
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
        <button className="back-btn" onClick={onBack}>
          <ChevronLeft /> Buckets
        </button>
      </div>

      <form className="form" onSubmit={handleSubmit}>
        <label className="form-label">Name</label>
        <input
          className="form-input"
          type="text"
          placeholder="e.g. Techno"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />

        {previewM3u && (
          <p className="form-hint" title={previewM3u}>
            Playlist: <span className="form-hint__path">{shortPath(previewM3u)}</span><br />
            Tracks → <span className="form-hint__path">{shortPath(`${rootDir}/library/`)}</span>
          </p>
        )}

        <label className="form-label">Color</label>
        <div className="color-picker">
          {BUCKET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`color-swatch${color === c ? ' color-swatch--active' : ''}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>

        <button type="submit" className="primary-btn" disabled={!canAdd}>
          Add Bucket
        </button>
      </form>
    </div>
  );
}

function shortPath(p: string) {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}
