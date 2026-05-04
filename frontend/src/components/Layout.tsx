import { Link, NavLink } from 'react-router-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { API_URL } from '@/api';

interface Progress {
  total: number;
  done: number;
  productId?: number;
  asin?: string;
  count?: number;
  finished?: boolean;
  error?: string;
}

export default function Layout({ children }: { children: ReactNode }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [errCount, setErrCount] = useState(0);
  const [okCount, setOkCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const startRefreshAll = async () => {
    if (running) return;
    setRunning(true);
    setProgress({ total: 0, done: 0 });
    setRecent([]);
    setErrCount(0);
    setOkCount(0);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${API_URL}/api/sellers/refresh-all`, {
        method: 'POST',
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() ?? '';
        for (const evt of events) {
          const line = evt.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try {
            const data = JSON.parse(line.slice(5).trim()) as Progress;
            setProgress(data);
            if (data.asin) {
              setRecent((r) => [
                `${data.asin} · ${data.error ? 'failed' : `${data.count ?? 0} sellers`}`,
                ...r,
              ].slice(0, 6));
              if (data.error) setErrCount((c) => c + 1);
              else setOkCount((c) => c + 1);
            }
            if (data.finished) {
              setTimeout(() => setRunning(false), 1200);
            }
          } catch {
            /* ignore parse errors */
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setRecent((r) => [`error: ${(e as Error).message}`, ...r].slice(0, 6));
      }
      setRunning(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const pct = progress && progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="site-header">
        <div className="max-w-[1400px] mx-auto px-10 py-5 flex items-center justify-between gap-6">
          <Link to="/" className="flex items-center gap-3 no-underline">
            <span className="brand-mark" aria-hidden>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.4" />
                <circle cx="12" cy="12" r="3.2" fill="currentColor" />
              </svg>
            </span>
            <span className="serif text-[22px]" style={{ color: 'var(--ink)' }}>Bird Eye</span>
            <span className="kicker hidden sm:inline">PW Observatory</span>
          </Link>

          <nav className="flex items-center gap-2">
            <NavLink to="/" end className={({ isActive }) => `nav-tab ${isActive ? 'active' : ''}`}>Products</NavLink>
            <NavLink to="/cohorts" className={({ isActive }) => `nav-tab ${isActive ? 'active' : ''}`}>Cohorts</NavLink>
            <NavLink to="/report" className={({ isActive }) => `nav-tab ${isActive ? 'active' : ''}`}>Report</NavLink>
          </nav>

          <div className="flex items-center gap-3">
            {!running ? (
              <button
                className="btn btn-primary"
                onClick={startRefreshAll}
                title="Scrape sellers for every Amazon SKU"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M3 8a5 5 0 0 1 8.6-3.5L13 3v4H9l1.6-1.6A3.5 3.5 0 1 0 11.5 8H13a5 5 0 1 1-10 0z" fill="currentColor" />
                </svg>
                Fetch all sellers
              </button>
            ) : (
              <button className="btn" onClick={stop}>Stop</button>
            )}
            <span className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted)' }}>
              <span className="ring-dot" />
              Live
            </span>
          </div>
        </div>

        {running && (
          <div className="refresh-bar">
            <div className="max-w-[1400px] mx-auto px-10 py-3">
              <div className="flex items-center justify-between text-[11px] mb-1.5">
                <span className="kicker">
                  Fetching sellers · {progress?.done ?? 0} / {progress?.total ?? '?'}
                </span>
                <span className="mono" style={{ color: 'var(--faint)' }}>
                  {okCount} ok · {errCount} failed
                  {progress?.asin ? ` · ${progress.asin}` : ''}
                </span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
              {recent[0] && (
                <div className="mono text-[11px] mt-1.5 truncate" style={{ color: 'var(--faint)' }}>
                  {recent[0]}
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 w-full max-w-[1400px] mx-auto px-10 py-12">{children}</main>

      <footer className="w-full max-w-[1400px] mx-auto px-10 py-10 mt-8">
        <div className="divider mb-6" />
        <div className="flex justify-between items-center text-[12px]" style={{ color: 'var(--faint)' }}>
          <span>© Bird Eye · PW Observatory</span>
          <span className="kicker">Quiet · Precise · Continuous</span>
        </div>
      </footer>
    </div>
  );
}
