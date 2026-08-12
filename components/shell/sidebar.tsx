'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  BookOpen,
  ChartPie,
  LayoutDashboard,
  Megaphone,
  Moon,
  Settings,
  Sun,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useEffect, useState } from 'react';

const NAV = [
  { href: '/executive', label: 'Executive', icon: LayoutDashboard },
  { href: '/finance', label: 'Finance', icon: Wallet },
  { href: '/sales', label: 'Sales', icon: TrendingUp },
  { href: '/marketing', label: 'Marketing', icon: Megaphone },
  { href: '/forecast', label: 'Forecast', icon: ChartPie },
  { href: '/kpi-dictionary', label: 'KPI dictionary', icon: BookOpen },
  { href: '/admin', label: 'Admin', icon: Settings },
];

export function Sidebar({ userName, userRole }: { userName: string; userRole: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Navigation preserves the global month and division, so moving between
  // dashboards never silently re-anchors the reporting period.
  const carried = new URLSearchParams();
  const month = searchParams.get('month');
  const division = searchParams.get('division');
  if (month) carried.set('month', month);
  if (division) carried.set('division', division);
  const suffix = carried.toString() ? `?${carried.toString()}` : '';

  return (
    <nav
      className="sticky top-0 flex h-dvh w-[208px] shrink-0 flex-col border-r"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-2.5 px-5 py-4">
        <div
          aria-hidden
          className="h-6 w-6 shrink-0 rounded-md"
          style={{ background: 'linear-gradient(135deg, var(--series-1), var(--series-3))' }}
        />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold leading-tight tracking-tight">
            Alliance Risk
          </p>
          <p className="text-[10px] leading-tight text-[var(--text-muted)]">Westport Financial</p>
        </div>
      </div>

      <ul className="flex-1 space-y-0.5 px-2.5 py-2">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={`${item.href}${suffix}`}
                aria-current={active ? 'page' : undefined}
                className="flex items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-1.5 text-[12.5px] transition-colors"
                style={{
                  background: active ? 'var(--surface-2)' : 'transparent',
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                <Icon size={15} aria-hidden />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
        <div className="mb-2.5">
          <p className="truncate text-[12px] font-medium leading-tight">{userName}</p>
          <p className="text-[10.5px] capitalize text-[var(--text-muted)]">
            {userRole.toLowerCase().replace('_', ' ')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <form action="/api/logout" method="post">
            <button
              type="submit"
              className="text-[11px] text-[var(--text-muted)] underline-offset-2 hover:underline"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('arg-theme');
    if (stored === 'light' || stored === 'dark') setTheme(stored);
  }, []);

  function toggle() {
    const root = document.documentElement;
    const current =
      theme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('arg-theme', next);
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title="Toggle light and dark"
      className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] border transition-colors hover:bg-[var(--surface-2)]"
      style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
    >
      {theme === 'dark' ? <Sun size={12} aria-hidden /> : <Moon size={12} aria-hidden />}
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}
