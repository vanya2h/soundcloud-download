import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '../../styles/popup.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e }; }
  render() {
    if (this.state.error) {
      const e = this.state.error as Error;
      return (
        <div style={{ padding: 16, fontFamily: 'monospace', fontSize: 12, color: '#ff4466', background: '#111', height: '100%', overflow: 'auto' }}>
          <strong>Crash:</strong> {e.message}
          <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: '#888', fontSize: 10 }}>{e.stack}</pre>
        </div>
      );
    }
    return this.state.error === null ? this.props.children : null;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
