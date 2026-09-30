/**
 * The headline row: the handful of figures a reader wants before any table.
 *
 * Each tile is one number and one line of context. A comparison always says
 * what it is against ("vs budget", "vs Jul 2026"), and a good or bad reading is
 * carried by words and a sign as well as colour, so it survives a greyscale
 * print and colour-blind eyes alike.
 */
import type { ReactNode } from 'react';

export interface HeadlineTile {
  label: string;
  value: string;
  /** e.g. "95.5% of budget" or "+$12,400 vs Jul 2026". */
  context?: string;
  tone?: 'good' | 'bad' | 'neutral';
  hint?: string;
  href?: string;
}

export function Headline({ tiles }: { tiles: HeadlineTile[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {tiles.map((tile) => (
        <Tile key={tile.label} tile={tile} />
      ))}
    </div>
  );
}

function Tile({ tile }: { tile: HeadlineTile }) {
  const color =
    tile.tone === 'good' ? 'var(--delta-good)' : tile.tone === 'bad' ? 'var(--delta-bad)' : 'var(--text-muted)';
  const body: ReactNode = (
    <>
      <p className="text-[11px] font-medium uppercase tracking-[0.05em] text-[var(--text-muted)]">{tile.label}</p>
      <p className="mt-1.5 truncate text-[22px] font-semibold leading-none tracking-tight tabular-nums">{tile.value}</p>
      {tile.context ? (
        <p className="mt-2 text-[11.5px] leading-snug" style={{ color }}>
          {tile.context}
        </p>
      ) : null}
    </>
  );
  const className =
    'block rounded-[var(--radius-lg)] border px-3.5 py-3 transition-shadow hover:shadow-[var(--shadow-raised)]';
  const style = { borderColor: 'var(--border)', background: 'var(--surface-1)', boxShadow: 'var(--shadow-card)' };

  return tile.href ? (
    <a href={tile.href} className={className} style={style} title={tile.hint}>
      {body}
    </a>
  ) : (
    <div className={className} style={style} title={tile.hint}>
      {body}
    </div>
  );
}
