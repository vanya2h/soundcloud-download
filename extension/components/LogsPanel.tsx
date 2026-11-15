import { useState, useEffect, useRef } from 'react';
import { storage } from 'wxt/storage';
import type { LogEntry } from '../utils/types';
import { sendToBackground } from '../utils/messaging';

interface Props {
  onBack: () => void;
}

export default function LogsPanel({ onBack }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sendToBackground<{ logs: LogEntry[] }>({ action: 'getLogs' }).then((res) => {
      setLogs(res?.logs ?? []);
    });

    const unwatch = storage.watch<LogEntry[]>('local:logs', (newLogs) => {
      setLogs(newLogs ?? []);
    });

    return unwatch;
  }, []);

  async function clearLogs() {
    await sendToBackground({ action: 'clearLogs' });
    setLogs([]);
  }

  return (
    <div className="view">
      <div className="view-nav">
        <button className="back-btn" onClick={onBack}><ChevronLeft /> Back</button>
        <button className="text-btn text-btn--muted" onClick={clearLogs} disabled={logs.length === 0}>
          Clear
        </button>
      </div>

      {logs.length === 0 ? (
        <div className="empty-state"><span className="muted">No activity yet.</span></div>
      ) : (
        <div className="log-list">
          {logs.map((entry) => (
            <div key={entry.id} className={`log-entry log-entry--${entry.level}`}>
              <span className="log-time">{formatTime(entry.time)}</span>
              <span className="log-msg">{entry.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}
