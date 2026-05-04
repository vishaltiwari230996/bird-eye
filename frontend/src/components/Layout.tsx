import { Link, NavLink } from 'react-router-dom';
import { type ReactNode } from 'react';

export default function Layout({ children }: { children: ReactNode }) {
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
            <span className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted)' }}>
              <span className="ring-dot" />
              Live
            </span>
          </div>
        </div>
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
