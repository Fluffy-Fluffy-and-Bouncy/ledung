// Usage charts (step 5), in plain HTML and CSS so they stay readable on a phone and follow the theme.
// Colours: the validated categorical palette (--s1 … --s8), assigned to each model, project or
// "started by" in a fixed order that doesn't change with filters; more than seven fold into "Other".
// Every chart has a legend, a hover/tap tooltip and a table next to it, since some light-mode colours
// are below 3:1 contrast.
import { useState, type ReactNode } from 'react';
import type { SessionInfo, UsageStopInfo } from '../../../src/shared/protocol.ts';
import { resetsInText } from '../../../src/shared/usage-stop-text.ts';
import { LimitShip } from '../components/LimitShip.tsx';
import { MeterStopLine } from '../components/UsageStopsSettings.tsx';
import type { Hull } from '../components/shipFrames.ts';
import { forecastAt } from './projection.ts';
import { accountLabel } from '../limitAccount.ts';
import { hasReset, readingAge, shownAge } from './readingAge.ts';

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function formatCost(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 100) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "PR #214 ✓" — the checks as a symbol; the title text names them in words. */
export function prLabel(pr: NonNullable<SessionInfo['pr']>): string {
  const checks = { passing: ' ✓', failing: ' ✗', running: ' …', none: '' }[pr.checks];
  const state = pr.state === 'open' ? '' : ` (${pr.state})`;
  return `PR #${pr.number}${checks}${state}`;
}


/** Models Ledung knows, in palette order; others follow alphabetically. */
const MODEL_ORDER = ['opus-5-5', 'sonnet-5-5', 'haiku-5-5', 'fable-5-1', 'opus-5', 'sonnet-5', 'haiku-4-5'];
export const TRIGGERS = ['user', 'answer', 'manager', 'ledung', 'unknown'];
export const TRIGGER_LABEL: Record<string, string> = {
  user: 'You typed', answer: 'Your answer', manager: 'A manager', ledung: 'Ledung update', unknown: 'Unknown',
};

/** A stable colour per key: the key's place in the full list, never its rank in the filtered data. */
export function colorMap(kind: 'model' | 'project' | 'trigger', keys: string[]): (key: string) => string {
  let ordered: string[];
  if (kind === 'model') ordered = [...MODEL_ORDER, ...keys.filter((k) => !MODEL_ORDER.includes(k)).sort()];
  else if (kind === 'trigger') ordered = TRIGGERS;
  else ordered = [...keys].sort();
  return (key) => {
    if (kind === 'trigger' && key === 'unknown') return 'var(--s-other)';
    const i = ordered.indexOf(key);
    return i >= 0 && i < 7 ? `var(--s${i + 1})` : 'var(--s-other)';
  };
}

export function Legend({ items }: { items: { label: string; color: string; textured?: boolean }[] }) {
  return (
    <div className="viz-legend">
      {items.map((i) => (
        <span key={i.label} className="viz-legend-item">
          <span className={`viz-swatch${i.textured ? ' textured' : ''}`} style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/** A hover/tap tooltip anchored to its column. */
function Tip({ children }: { children: ReactNode }) {
  return <div className="viz-tip" role="tooltip">{children}</div>;
}

export interface StackSeries {
  key: string;
  label: string;
  color: string;
}

/**
 * Stacked bars, one per column (a day or a call). Thin columns, a 2px gap between segments, the top
 * rounded; a grid of three recessive lines; hover or tap a column for its values.
 */
export function StackedBars(props: {
  columns: { label: string; short?: string; values: Record<string, number>; textured?: boolean; note?: string }[];
  series: StackSeries[];
  height?: number;
  emptyText?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const height = props.height ?? 160;
  const totals = props.columns.map((c) => props.series.reduce((n, s) => n + (c.values[s.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  if (!props.columns.length) return <p className="muted">{props.emptyText ?? 'Nothing in this period.'}</p>;
  const grid = [max, max / 2];
  const labelEvery = Math.max(1, Math.ceil(props.columns.length / 8));
  return (
    <div className="viz-bars" style={{ height: height + 22 }} onMouseLeave={() => setActive(null)}>
      <div className="viz-grid" style={{ height }}>
        {grid.map((g) => (
          <div key={g} className="viz-gridline" style={{ bottom: `${(g / max) * 100}%` }}>
            <span>{formatTokens(g)}</span>
          </div>
        ))}
      </div>
      <div className="viz-cols" style={{ height }}>
        {props.columns.map((c, i) => {
          const segs = props.series.filter((s) => (c.values[s.key] ?? 0) > 0);
          return (
            <div
              key={i}
              className={`viz-col${active === i ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => setActive(active === i ? null : i)}
            >
              <div className="viz-stack" style={{ height: `${(totals[i]! / max) * 100}%` }}>
                {segs.map((s) => (
                  <div
                    key={s.key}
                    className={`viz-seg${c.textured ? ' textured' : ''}`}
                    style={{ flexGrow: c.values[s.key], background: s.color }}
                  />
                ))}
              </div>
              {active === i && (
                <Tip>
                  <strong>{c.label}</strong>
                  {c.note && <div className="muted">{c.note}</div>}
                  {segs.slice().reverse().map((s) => (
                    <div key={s.key} className="viz-tip-row">
                      <span className="viz-swatch" style={{ background: s.color }} /> {s.label}
                      <span className="viz-tip-num">{formatTokens(c.values[s.key] ?? 0)}</span>
                    </div>
                  ))}
                  {segs.length > 1 && (
                    <div className="viz-tip-row total">Total <span className="viz-tip-num">{formatTokens(totals[i]!)}</span></div>
                  )}
                </Tip>
              )}
              {i % labelEvery === 0 && <span className="viz-xlabel">{c.short ?? c.label}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A big figure with a label: for the handful of numbers that matter most. */
export function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="viz-tile">
      <div className="viz-tile-label">{label}</div>
      <div className="viz-tile-value">{value}</div>
      {sub && <div className="viz-tile-sub">{sub}</div>}
    </div>
  );
}

const LIMIT_LABEL: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: '7-day',
  seven_day_opus: '7-day Opus',
  seven_day_sonnet: '7-day Sonnet',
  seven_day_overage_included: '7-day (incl. extra)',
  overage: 'Extra usage',
};

/** Limits drawn as a ship rather than a plain bar: the 5-hour window as a fleet's small boat, the week as the ship. */
const SHIP_LIMITS: Record<string, Hull> = { five_hour: 'boat', seven_day: 'ship' };

const STATUS: Record<string, { label: string; icon: string; cls: string }> = {
  allowed: { label: 'OK', icon: '●', cls: 'good' },
  allowed_warning: { label: 'Close to the limit', icon: '▲', cls: 'warning' },
  rejected: { label: 'Limit reached', icon: '■', cls: 'critical' },
};

const resetIn = (at: number | null, kind: string): string => resetsInText(at, Date.now(), kind);

/** The plan's usage limits as small meters (status colour with an icon and a label, never colour alone) for one account, named; "no data yet" while it has none. Other accounts' numbers are never shown in its place. */
export function LimitMeters({ account, limits, stops = [], run }: { account: string; limits: (MeterLimit & { account?: string })[]; stops?: UsageStopInfo[]; run?: (action: () => Promise<unknown>) => Promise<void> }) {
  const mine = limits.filter((l) => (l.account ?? 'default') === account);
  const name = <div className="limits-account-name muted">{accountLabel(account)}{!mine.length && ' · no data yet'}</div>;
  if (!mine.length) return <div className="limits-account">{name}</div>;
  return (
    <div className="limits-account">
      {name}
      {/* Keyed by account so a switch brings fresh ships instead of one sailing off as if a window had reset. */}
      <LimitList key={account} limits={mine} stops={stops.filter((s) => s.account === account)} run={run} />
    </div>
  );
}

type MeterLimit = { kind: string; status: string; utilization: number | null; resetsAt: number | null; at: number; seenAt?: number };

function LimitList({ limits, stops, run }: { limits: MeterLimit[]; stops: UsageStopInfo[]; run?: (action: () => Promise<unknown>) => Promise<void> }) {
  const now = Date.now();
  return (
    <div className="limits">
      {limits.map((l) => {
        // A window that reset since the reading: its figure is the earlier window's, so none is shown (issue #360).
        if (hasReset(l, now)) {
          return (
            <div key={l.kind} className={`limit limit-reset${SHIP_LIMITS[l.kind] ? ' with-ship' : ''}`} title={`${LIMIT_LABEL[l.kind] ?? l.kind}: the window has reset since the last reading (${readingAge(l, now)}). A new one comes with the next turn on this account.`}>
              <div className="limit-head">
                <span>{LIMIT_LABEL[l.kind] ?? l.kind}</span>
                <span className="limit-status">reset</span>
              </div>
              <div className="limit-sub muted"><span>no reading since the reset</span></div>
            </div>
          );
        }
        const age = shownAge(l, now);
        const st = STATUS[l.status] ?? { label: l.status, icon: '●', cls: 'good' };
        const ship = l.utilization != null ? SHIP_LIMITS[l.kind] : undefined;
        const forecast = ship && l.utilization != null ? forecastAt(l.kind, l.utilization, l.resetsAt) : null;
        const stop = stops.find((s) => s.kind === l.kind);
        return (
          <div key={l.kind} className={`limit${ship ? ' with-ship' : ''}`} title={`${LIMIT_LABEL[l.kind] ?? l.kind}: ${st.label}${l.utilization != null ? `, ${pct(l.utilization)} used` : ''}${forecast?.share != null ? `, about ${pct(forecast.share)} by the reset at this pace` : ''}. ${resetIn(l.resetsAt, l.kind)}. Reading ${readingAge(l, now)}: Ledung hears the limits during a session's turn.`}>
            {/* A ship meter has no heading: the hover names the window (Martin, issue #70). */}
            {!ship && (
              <div className="limit-head">
                <span>{LIMIT_LABEL[l.kind] ?? l.kind}</span>
                <span className={`limit-status ${st.cls}`}>{st.icon} {l.utilization != null ? pct(l.utilization) : st.label}</span>
              </div>
            )}
            {ship && l.utilization != null ? (
              <div className="limit-ship-box"><LimitShip utilization={l.utilization} label={LIMIT_LABEL[l.kind]!} hull={ship} /></div>
            ) : l.utilization != null && (
              <div className="limit-track">
                <div className={`limit-fill ${st.cls}`} style={{ width: `${Math.min(100, l.utilization * 100)}%` }} />
              </div>
            )}
            <div className="limit-sub muted">
              {/* A stop's line below counts down to the reset already. */}
              <span>{stop && run ? '' : resetIn(l.resetsAt, l.kind)}</span>
              {forecast && (
                // The ship already shows the figure; say where it is heading instead, or why it can't yet.
                forecast.share != null
                  ? <span className={`limit-forecast${forecast.share >= 1 ? ' over' : ''}`}>≈ {pct(forecast.share)} by reset</span>
                  : <span className="limit-forecast" title={forecast.why}>≈ — by reset</span>
              )}
            </div>
            {age && <div className="limit-sub limit-age">{age}</div>}
            {stop && run && <MeterStopLine stop={stop} run={run} />}
          </div>
        );
      })}
    </div>
  );
}
