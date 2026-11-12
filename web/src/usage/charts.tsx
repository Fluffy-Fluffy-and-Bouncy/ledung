// Usage charts (step 5), in plain HTML and CSS so they stay readable on a phone and follow the theme.
// Colours: the validated categorical palette (--s1 … --s8), assigned to each model, project or
// "started by" in a fixed order that doesn't change with filters; more than seven fold into "Other".
// Every chart has a legend, a hover/tap tooltip and a table next to it, since some light-mode colours
// are below 3:1 contrast.
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useNow } from '../clock.ts';
import type { SessionInfo, UsageStopInfo } from '../../../src/shared/protocol.ts';
import { meterStopHead, resetsInText, resetsInVariants } from '../../../src/shared/usage-stop-text.ts';
import { LimitShip } from '../components/LimitShip.tsx';
import { api } from '../api.ts';
import type { Hull } from '../components/shipFrames.ts';
import { forecastAt } from './projection.ts';
import { accountLabel } from '../limitAccount.ts';
import { hasReset, readingAge, shownAge } from './readingAge.ts';
import { shownLimits } from './limitsShown.ts';
import { meterLineLayout, meterLineVariants } from './meterLine.ts';

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
const labelOf = (kind: string) => LIMIT_LABEL[kind] ?? kind;

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
  const { shown, folded } = shownLimits(limits, now, new Set(stops.filter((s) => s.holding).map((s) => s.kind)));
  return (
    <div className="limits">
      {shown.map((l) => {
        // A window that reset since the reading: its figure is the earlier window's, so none is shown (issue #360).
        if (hasReset(l, now)) {
          return (
            <div key={l.kind} className={`limit limit-reset${SHIP_LIMITS[l.kind] ? ' with-ship' : ''}`} title={`${labelOf(l.kind)}: the window has reset since the last reading (${readingAge(l, now)}). A new one comes with the next turn on this account.${foldedText(folded.get(l.kind), now)}`}>
              <div className="limit-head">
                <span>{labelOf(l.kind)}</span>
                <span className="limit-status">reset</span>
              </div>
              <div className="limit-sub muted"><span>no reading since the reset</span></div>
            </div>
          );
        }
        return <LimitRow key={l.kind} l={l} stop={run ? stops.find((s) => s.kind === l.kind) : undefined} run={run} folded={folded.get(l.kind)} />;
      })}
    </div>
  );
}

/** A window folded into this meter, as a sentence for its hover: " 7-day (incl. extra): 40% used. Weekly (incl. extra) limit resets in 3 d." */
function foldedText(f: MeterLimit | undefined, now: number): string {
  if (!f) return '';
  if (hasReset(f, now)) return ` ${labelOf(f.kind)}: reset since the last reading (${readingAge(f, now)}).`;
  const reset = resetsInText(f.resetsAt, now, f.kind);
  return ` ${labelOf(f.kind)}${f.utilization != null ? `: ${pct(f.utilization)} used` : ''}${reset ? `. ${reset}` : ''}.`;
}

function LimitRow({ l, stop, run, folded }: { l: MeterLimit; stop?: UsageStopInfo; run?: (action: () => Promise<unknown>) => Promise<void>; folded?: MeterLimit }) {
  // The countdown moves by the minute even when nothing else on the page changes; on the page's shared clock (#233).
  const now = useNow(30_000);
  const age = shownAge(l, now);
  const st = STATUS[l.status] ?? { label: l.status, icon: '●', cls: 'good' };
  const ship = l.utilization != null ? SHIP_LIMITS[l.kind] : undefined;
  const forecast = ship && l.utilization != null ? forecastAt(l.kind, l.utilization, l.resetsAt) : null;
  // A stop's line counts down to the reset itself, so the meter has one line under it, not two (issues #280, #284).
  const variants = meterLineVariants(
    stop ? meterStopHead(stop) : null,
    stop ? resetsInVariants(stop.resetsAt, now, stop.kind) : resetsInVariants(l.resetsAt, now, l.kind),
  );
  // The ship already shows the figure; say where it is heading instead, or why it can't yet.
  const forecastEl = (measuring = false) => forecast && (
    forecast.share != null
      ? <span className={`limit-forecast${forecast.share >= 1 ? ' over' : ''}`} aria-hidden={measuring || undefined}>≈ {pct(forecast.share)} by reset</span>
      : <span className="limit-forecast" title={forecast.why} aria-hidden={measuring || undefined}>≈ — by reset</span>
  );
  const forecastKey = forecast ? (forecast.share != null ? `${pct(forecast.share)}${forecast.share >= 1 ? '!' : ''}` : '—') : null;
  // Whether the ship's strip can leave room for the forecast beside it and keep its figure; the ship says.
  const [besideShip, setBesideShip] = useState(true);
  const { line, measure, layout } = useMeterLine(variants, forecastKey, besideShip);
  const parts = layout.variant >= 0 && variants[layout.variant] ? variants[layout.variant]!.split(' · ') : [];
  return (
    <div className={`limit${ship ? ' with-ship' : ''}`} title={`${labelOf(l.kind)}: ${st.label}${l.utilization != null ? `, ${pct(l.utilization)} used` : ''}${forecast?.share != null ? `, about ${pct(forecast.share)} by the reset at this pace` : ''}. ${resetIn(l.resetsAt, l.kind)}. Reading ${readingAge(l, now)}: Ledung hears the limits during a session's turn.${foldedText(folded, now)}`}>
      {/* A ship meter has no heading: the hover names the window (Martin, issue #70). */}
      {!ship && (
        <div className="limit-head">
          <span>{labelOf(l.kind)}</span>
          <span className={`limit-status ${st.cls}`}>{st.icon} {l.utilization != null ? pct(l.utilization) : st.label}</span>
        </div>
      )}
      {ship && l.utilization != null ? (
        <div className="limit-ship-box">
          <div className="limit-ship-fit">
            <LimitShip utilization={l.utilization} label={LIMIT_LABEL[l.kind]!} hull={ship}
              side={forecast ? layout.forecastPx + 6 : 0} useSide={!layout.forecastInline} onSide={setBesideShip} />
          </div>
          {/* No room on the line below: the forecast rides beside the ship, level with its water line (issue #284). */}
          {!layout.forecastInline && forecastEl()}
        </div>
      ) : l.utilization != null && (
        <div className="limit-track">
          <div className={`limit-fill ${st.cls}`} style={{ width: `${Math.min(100, l.utilization * 100)}%` }} />
        </div>
      )}
      <div className={stop ? `limit-stop${stop.holding ? ' held' : ''}` : 'limit-sub muted'}>
        <div className="limit-sub-line" ref={line}>
          {/* Wraps only between its parts, never inside one; the hover keeps the whole line. */}
          <span className="limit-line-text" title={variants[0]}>
            {parts.map((p, i) => <Fragment key={i}>{i > 0 && ' '}<span className="nowrap">{i < parts.length - 1 ? `${p} ·` : p}</span></Fragment>)}
          </span>
          {layout.forecastInline && forecastEl()}
          <span className="limit-measure" ref={measure} aria-hidden="true">
            {variants.map((v) => <span key={v}>{v}</span>)}
            {forecastEl(true)}
          </span>
        </div>
        {stop?.holding && run && <button className="small primary" onClick={() => void run(() => api.liftUsageStop(stop.account, stop.kind))}>Lift</button>}
      </div>
      {age && <div className="limit-sub limit-age">{age}</div>}
    </div>
  );
}

/** Measures the line's variants and the forecast in the line's own font, and picks the layout that fits its width. */
function useMeterLine(variants: string[], forecastKey: string | null, besideShip: boolean) {
  const line = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [room, setRoom] = useState(0);
  const [layout, setLayout] = useState<{ variant: number; forecastInline: boolean; forecastPx: number }>({ variant: 0, forecastInline: true, forecastPx: 0 });
  useLayoutEffect(() => {
    const el = line.current;
    if (!el) return;
    const fit = () => setRoom(el.clientWidth);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const key = variants.join('\n');
  useLayoutEffect(() => {
    const kids = Array.from(measure.current?.children ?? []);
    if (!room || !kids.length) return;
    const width = (i: number) => kids[i]?.getBoundingClientRect().width ?? 0;
    // A pixel of slack: a width that rounds the other way must not wrap the line.
    const forecastPx = forecastKey ? Math.ceil(width(variants.length)) : 0;
    const next = { ...meterLineLayout({ widths: variants.map((_, i) => width(i) + 1), forecast: forecastPx, room, gap: 6, besideShip }), forecastPx };
    setLayout((was) => (was.variant === next.variant && was.forecastInline === next.forecastInline && was.forecastPx === next.forecastPx ? was : next));
  }, [room, key, forecastKey, besideShip]);
  return { line, measure, layout };
}
