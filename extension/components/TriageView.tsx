import { useState, useEffect, useCallback, useRef } from 'react';
import type { Bucket, LikedTrack } from '../utils/types';
import { BUCKET_COLORS } from '../utils/types';
import { sendToBackground } from '../utils/messaging';

interface Props {
  buckets: Bucket[];
  onBack: () => void;
  onBucketAdded: () => void;
}

export default function TriageView({ buckets: propBuckets, onBack, onBucketAdded }: Props) {
  const [tracks, setTracks] = useState<LikedTrack[]>([]);
  const [idx, setIdx] = useState(0);
  const [nextHref, setNextHref] = useState<string | undefined>();
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);
  const [exitDir, setExitDir] = useState<'left' | 'right' | null>(null);
  const [busy, setBusy] = useState(false);

  const [buckets, setBuckets] = useState(propBuckets);
  useEffect(() => setBuckets(propBuckets), [propBuckets]);

  const [showNewBucket, setShowNewBucket] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(BUCKET_COLORS[0]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [loadingStreamId, setLoadingStreamId] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const loadTracks = useCallback(async (href?: string) => {
    if (href) setLoadingMore(true); else setInitialLoading(true);
    const res = await sendToBackground<{ tracks: LikedTrack[]; nextHref?: string }>({
      action: 'fetchLikedTracks',
      nextHref: href,
    });
    setTracks(prev => href ? [...prev, ...(res?.tracks ?? [])] : (res?.tracks ?? []));
    setNextHref(res?.nextHref);
    setInitialLoading(false);
    setLoadingMore(false);
  }, []);

  useEffect(() => { loadTracks(); }, [loadTracks]);

  const track = tracks[idx] ?? null;
  const remaining = tracks.length - idx;

  useEffect(() => {
    if (!loadingMore && nextHref && remaining <= 5) loadTracks(nextHref);
  }, [remaining, loadingMore, nextHref, loadTracks]);

  function stopAudio() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current.ontimeupdate = null;
      audioRef.current.onloadedmetadata = null;
    }
    setPlayingId(null);
    setCurrentTime(0);
    setDuration(0);
  }

  useEffect(() => () => stopAudio(), []);

  async function playTrack(t: LikedTrack) {
    stopAudio();
    setLoadingStreamId(t.id);
    const res = await sendToBackground<{ url?: string }>({ action: 'getStreamUrl', trackId: t.id });
    setLoadingStreamId(null);
    if (!res?.url) return;
    if (!audioRef.current) audioRef.current = new Audio();
    const audio = audioRef.current;
    audio.src = res.url;
    audio.onended = () => setPlayingId(null);
    audio.ontimeupdate = () => setCurrentTime(audio.currentTime);
    audio.onloadedmetadata = () => {
      const mid = audio.duration / 2;
      setDuration(audio.duration);
      audio.currentTime = mid;
      setCurrentTime(mid);
    };
    audio.play().catch(() => setPlayingId(null));
    setPlayingId(t.id);
  }

  function seek(time: number) {
    if (audioRef.current) audioRef.current.currentTime = time;
    setCurrentTime(time);
  }

  function togglePlay(t: LikedTrack) {
    if (playingId === t.id) { stopAudio(); return; }
    playTrack(t);
  }

  // Auto-play when card changes
  useEffect(() => {
    if (track) playTrack(track);
  }, [track?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Multi-select: set of bucket IDs chosen for the current track
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  function toggleBucket(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function advance(dir: 'left' | 'right', action?: () => void) {
    if (busy) return;
    setBusy(true);
    action?.();
    setExitDir(dir);
    setSessionCount(c => c + 1);
    setTimeout(() => {
      setIdx(i => i + 1);
      setExitDir(null);
      setBusy(false);
      setShowNewBucket(false);
      setNewName('');
      setSelectedIds(new Set());
    }, 230);
  }

  function done() {
    if (!track) return;
    stopAudio();
    const ids = Array.from(selectedIds);
    advance('right', () => {
      ids.forEach(bucketId => sendToBackground({
        action: 'download',
        url: track.url,
        trackInfo: { title: track.title, artist: track.artist },
        bucketId,
      }));
    });
  }

  function skip() {
    if (!track) return;
    stopAudio();
    advance('left', () => sendToBackground({ action: 'dismissTrack', trackId: track.id }));
  }

  async function createBucket() {
    if (!newName.trim()) return;
    const res = await sendToBackground<{ bucket?: Bucket; error?: string }>({
      action: 'addBucket', name: newName.trim(), color: newColor,
    });
    if (res?.error || !res?.bucket) { alert(res?.error ?? 'Failed to create bucket'); return; }
    const nb = res.bucket;
    setBuckets(prev => [...prev, nb]);
    setNewColor(BUCKET_COLORS[(buckets.length + 1) % BUCKET_COLORS.length]);
    onBucketAdded();
    // Select the new bucket and close the form — user can keep selecting or hit done
    setSelectedIds(prev => new Set([...prev, nb.id]));
    setShowNewBucket(false);
    setNewName('');
  }

  const suggested = track ? suggestBucket(track, buckets) : null;

  // Pre-select the suggestion when card changes
  useEffect(() => {
    setSelectedIds(suggested ? new Set([suggested.id]) : new Set());
  }, [track?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: ← skip, → or Enter done (if any selected), Space play
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (busy) return;
      if (e.key === 'ArrowLeft') skip();
      if ((e.key === 'ArrowRight' || e.key === 'Enter') && selectedIds.size > 0 && !showNewBucket) done();
      if (e.key === ' ') { e.preventDefault(); if (track) togglePlay(track); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (initialLoading) return (
    <div className="view">
      <TriageNav onBack={onBack} sessionCount={sessionCount} />
      <div className="empty-state"><span className="muted">Loading likes…</span></div>
    </div>
  );

  if (!track && !loadingMore) return (
    <div className="view">
      <TriageNav onBack={onBack} sessionCount={sessionCount} />
      <div className="empty-state">
        {sessionCount > 0 ? (
          <div className="triage-done">
            <div className="triage-done__badge">{sessionCount}</div>
            <div className="triage-done__label">sorted this session</div>
            <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>All caught up!</p>
          </div>
        ) : (
          <span className="muted">No unsorted tracks</span>
        )}
      </div>
    </div>
  );

  return (
    <div className="view triage-view">
      <TriageNav onBack={onBack} sessionCount={sessionCount} />

      {/* Card stage */}
      <div className="triage-stage">
        {track && (
          <div
            key={idx}
            className={`triage-card${exitDir === 'left' ? ' triage-card--exit-left' : exitDir === 'right' ? ' triage-card--exit-right' : ''}`}
          >
            <div className="triage-card__artist">{track.artist}</div>
            <div className="triage-card__title">{track.title}</div>
            <button
              className={`triage-play-btn${playingId === track.id ? ' triage-play-btn--playing' : ''}${loadingStreamId === track.id ? ' triage-play-btn--loading' : ''}`}
              onClick={() => togglePlay(track)}
              disabled={loadingStreamId === track.id}
              title={playingId === track.id ? 'Stop (Space)' : 'Preview (Space)'}
            >
              {loadingStreamId === track.id ? <SpinnerIcon /> : playingId === track.id ? <StopIcon /> : <PlayIcon />}
            </button>

            {duration > 0 && (
              <div className="triage-scrubber">
                <input
                  type="range"
                  className="triage-scrubber__range"
                  style={{ '--pct': `${(currentTime / duration) * 100}%` } as React.CSSProperties}
                  min={0}
                  max={duration}
                  step={1}
                  value={currentTime}
                  onChange={e => seek(Number(e.target.value))}
                />
                <div className="triage-scrubber__times">
                  <span>{fmt(currentTime)}</span>
                  <span>{fmt(duration)}</span>
                </div>
              </div>
            )}

            {(track.genre || track.tags.length > 0) && (
              <div className="triage-card__tags">
                {track.genre && <span className="triage-tag triage-tag--genre">{track.genre}</span>}
                {track.tags.slice(0, 4).map(t => <span key={t} className="triage-tag">#{t}</span>)}
              </div>
            )}
          </div>
        )}
        {loadingMore && !track && (
          <div className="triage-card triage-card--placeholder">
            <span className="muted" style={{ fontSize: 12 }}>Loading more…</span>
          </div>
        )}
      </div>

      {/* Action panel */}
      <div className="triage-panel">
        <div className="triage-chips">
          {buckets.map(b => {
            const on = selectedIds.has(b.id);
            const isSuggested = b.id === suggested?.id;
            return (
              <button
                key={b.id}
                className={`triage-chip${on ? ' triage-chip--on' : ''}${isSuggested && !on ? ' triage-chip--suggested' : ''}`}
                onClick={() => toggleBucket(b.id)}
                disabled={busy}
              >
                <span className="triage-chip__dot" style={{ background: b.color }} />
                {b.name}
                {on && <span className="triage-chip__check">✓</span>}
              </button>
            );
          })}
          <button
            className={`triage-chip triage-chip--new${showNewBucket ? ' triage-chip--new-open' : ''}`}
            onClick={() => setShowNewBucket(v => !v)}
          >
            + New
          </button>
        </div>

        {showNewBucket && (
          <div className="triage-new-bucket">
            <div className="triage-new-bucket__row">
              <input
                className="triage-new-bucket__input"
                placeholder="Bucket name"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') createBucket();
                  if (e.key === 'Escape') { setShowNewBucket(false); setNewName(''); }
                }}
                autoFocus
              />
              <button
                className="triage-new-bucket__go"
                disabled={!newName.trim()}
                onClick={createBucket}
              >→</button>
            </div>
            <div className="triage-new-bucket__colors">
              {BUCKET_COLORS.map(c => (
                <button
                  key={c}
                  className={`triage-color-dot${newColor === c ? ' triage-color-dot--active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setNewColor(c)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="triage-footer">
          {selectedIds.size > 0 ? (
            <button className="triage-done-btn" onClick={done} disabled={busy}>
              Add to {selectedIds.size === 1 ? buckets.find(b => b.id === [...selectedIds][0])?.name ?? 'bucket' : `${selectedIds.size} buckets`}
              <span className="triage-btn-hint">↵</span>
            </button>
          ) : (
            <button className="triage-skip" onClick={skip} disabled={busy}>
              Skip <span className="triage-skip__hint">←</span>
            </button>
          )}
          {selectedIds.size > 0 && (
            <button className="triage-skip triage-skip--sm" onClick={skip} disabled={busy}>
              Skip
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TriageNav({ onBack, sessionCount }: { onBack: () => void; sessionCount: number }) {
  return (
    <div className="view-nav">
      <button className="back-btn" onClick={onBack}><ChevronLeft /> Back</button>
      {sessionCount > 0 && <span className="triage-session-badge">{sessionCount} sorted</span>}
    </div>
  );
}

function suggestBucket(track: LikedTrack, buckets: Bucket[]): Bucket | null {
  const haystack = [track.genre, ...track.tags, track.title].join(' ').toLowerCase();
  const sorted = [...buckets].sort((a, b) => b.name.length - a.name.length);
  for (const b of sorted) {
    if (b.name.toLowerCase().split(/\s+/).every(w => haystack.includes(w))) return b;
  }
  return null;
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}

function PlayIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>;
}

function StopIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>;
}

function SpinnerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" className="triage-spin">
      <path d="M12 2a10 10 0 0 1 10 10"/>
    </svg>
  );
}
