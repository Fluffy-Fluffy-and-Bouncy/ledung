// Machine resources (step 6): the load of this computer and Docker's VM, how many sessions work and
// the limit (editable), the line for a free place with Start now, and what one session's turns used.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { projectLabel, type MachineInfo, type Priority, type ResourcesInfo, type SessionInfo, type TurnResource, type TypicalCost } from '../../../src/shared/protocol.ts';
import { formatBytes, formatCores, meterLevel } from '../../../src/shared/machine-shown.ts';
import { dimLabel, formatDim } from '../../../src/resources/limits.ts';
import { api } from '../api.ts';
import { pollWhileShown } from '../pollShown.ts';
import { dragMax, dragStep, dragText, dragValue, limitShare, limitText, limitUnits, overFor, parseLimitInput, stepDrag, valueShare } from './resourceLimits.ts';
import { jobOpen, jobUse, waitingOpen } from './machineFold.ts';

// Shared with the server, which sends the machine's figures only when what they show here changes (#230).
export { formatBytes, formatCores };

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export const PRIORITY_LABEL: Record<Priority, string> = { normal: 'Normal', high: 'High', critical: 'Critical' };

/** How far a press on a limit handle must move before it is a drag: a click or a graze sets nothing (issue #295, point 9). */
const DRAG_START_PX = 4;

/** Dragging a bar's limit line (issue #295): the limit in the API's unit (% or GB), the bar's total and how to set it. */
interface LimitSetting {
  value: number | null;
  /** 100 for CPU and GPU load, bytes for memory. */
  total: number;
  set: (value: number | null) => Promise<void>;
}

/**
 * A load meter: status colour with an icon and words, never colour alone. With resource limits (docs/steps/
 * resource-limits.md): what going jobs reserve but don't use yet hatched after the fill, the limit as a line, and the
 * editor for the limit (`dim`). With `setting` (issue #295) the line has a handle to drag, beside the bar's button
 * rather than in it so no control nests in another, and the editor opens on a double-click with a mouse, a tap, or
 * Enter on the bar (point 6).
 */
function Load({ label, used, total, text, limit, reserved, dim, open, onOpen, setting }: {
  label: string; used: number; total: number; text: string;
  /** The limit as a share of the bar (0–1); null: none. */
  limit?: number | null;
  reserved?: number;
  dim?: string;
  open?: boolean;
  onOpen?: (dim: string) => void;
  setting?: LimitSetting;
}) {
  // The value while the handle is dragged or keyed (undefined: not), and one applied until the page's figures show it.
  const [live, setLive] = useState<number | null | undefined>(undefined);
  const [keyed, setKeyed] = useState(false);
  const [pending, setPending] = useState<number | null | undefined>(undefined);
  const press = useRef<{ id: number; x: number; dragging: boolean } | null>(null);
  const lastPointer = useRef('mouse');
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackTop, setTrackTop] = useState(0);
  const hasSetting = !!setting;
  useEffect(() => setPending(undefined), [setting?.value]);
  // The handle layer sits over the track; where that is depends on the font, so it is measured, and again on a resize.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !hasSetting) return;
    const measure = () => setTrackTop(trackRef.current?.offsetTop ?? 0);
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(wrap);
    return () => ro?.disconnect();
  }, [hasSetting]);

  const share = total > 0 ? used / total : 0;
  const cls = meterLevel(share);
  const icon = { good: '●', warning: '▲', critical: '■' }[cls];
  const fill = Math.min(100, share * 100);
  const hatch = Math.max(0, Math.min(100 - fill, (reserved ?? 0) * 100));
  const now = setting ? (live !== undefined ? live : pending !== undefined ? pending : setting.value) : null;
  const limitPct = setting && dim
    ? (now === null ? null : valueShare(dim, now, setting.total) * 100)
    : limit === null || limit === undefined ? null : Math.min(100, Math.max(0, limit * 100));
  const how = setting ? 'double-click or tap to set its limit, or drag its handle' : 'click to set its limit';
  const title = `${label}: ${text}${cls === 'good' ? '' : cls === 'warning' ? ' (busy)' : ' (full)'}${limitPct !== null ? ` · limit at ${Math.round(limitPct)}%` : ''}${hatch > 0 ? ` · ${Math.round(hatch)}% reserved` : ''}${dim ? ` · ${how}` : ''}`;
  const body = (
    <>
      <div className="limit-head">
        <span>{label}</span>
        <span className={`limit-status ${cls}`}>{icon} {Math.round(share * 100)}%</span>
      </div>
      <div className="limit-track resource-track" ref={trackRef}>
        <div className={`limit-fill ${cls}`} style={{ width: `${fill}%` }} />
        {hatch > 0 && <div className="limit-reserved" style={{ left: `${fill}%`, width: `${hatch}%` }} />}
        {limitPct !== null && <div className="limit-line" style={{ left: `calc(${limitPct}% - 1px)` }} />}
      </div>
      <div className="limit-sub muted">{text}</div>
    </>
  );
  if (!dim || !onOpen) return <div className="limit" title={title}>{body}</div>;
  const ariaLabel = `${label}: ${text}. ${limitPct !== null ? `Limit at ${Math.round(limitPct)}%.` : 'No limit.'} Set its limit.`;
  if (!setting) {
    return (
      <button type="button" className={`limit limit-button${open ? ' open' : ''}`} title={title} aria-expanded={open} aria-label={ariaLabel} onClick={() => onOpen(dim)}>
        {body}
      </button>
    );
  }

  // One save per drag or Enter, and none when nothing changed (point 9).
  const apply = (v: number | null) => {
    if (v === setting.value) return;
    setPending(v);
    // Should the figures not change (a refused save), the line goes back to what the page knows.
    void setting.set(v).finally(() => setTimeout(() => setPending(undefined), 4000));
  };
  const at = (x: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    return dragValue(dim, r && r.width > 0 ? (x - r.left) / r.width : 1, setting.total);
  };
  // Ends a drag or keying without saving; the value label goes with it (point 9).
  const end = () => {
    press.current = null;
    setLive(undefined);
    setKeyed(false);
  };
  const pos = valueShare(dim, now, setting.total) * 100;
  const max = dragMax(dim, setting.total);
  return (
    <div ref={wrapRef} className={`limit limit-control${open ? ' open' : ''}${live !== undefined ? ' adjusting' : ''}${now === null ? ' no-limit' : ''}`}>
      <button type="button" className={`limit-button${open ? ' open' : ''}`} title={title} aria-expanded={open} aria-label={ariaLabel}
        onPointerDown={(e) => { lastPointer.current = e.pointerType; }}
        // A mouse opens the editor with a double-click, so a stray click by the handle does nothing; a tap, a pen and
        // the keyboard (detail 0) open it at once.
        onClick={(e) => { if (e.detail === 0 || lastPointer.current !== 'mouse') onOpen(dim); }}
        onDoubleClick={() => { if (lastPointer.current === 'mouse') onOpen(dim); }}>
        {body}
      </button>
      <div className="limit-handle-layer" style={{ top: trackTop }}>
        {live !== undefined && (
          <div className="limit-drag-label" aria-hidden="true" style={{ left: `${pos}%`, transform: `translateX(-${pos}%)` }}>
            {label} {dragText(dim, live)}{keyed && live !== setting.value ? ' · Enter sets it' : ''}
          </div>
        )}
        <div role="slider" tabIndex={0} className="limit-handle" style={{ left: `${pos}%` }}
          aria-label={`${label} limit`} aria-orientation="horizontal"
          aria-valuemin={dragStep(dim)} aria-valuemax={max} aria-valuenow={now ?? max} aria-valuetext={dragText(dim, now)}
          title={`${label} limit: ${dragText(dim, now)}. Drag it, or use the arrow keys and Enter; at the right end, no limit.`}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            press.current = { id: e.pointerId, x: e.clientX, dragging: false };
            setKeyed(false);
          }}
          onPointerMove={(e) => {
            const p = press.current;
            if (!p || p.id !== e.pointerId) return;
            if (!p.dragging && Math.abs(e.clientX - p.x) < DRAG_START_PX) return;
            p.dragging = true;
            setLive(at(e.clientX));
          }}
          onPointerUp={(e) => {
            const p = press.current;
            if (!p || p.id !== e.pointerId) return;
            const v = p.dragging ? at(e.clientX) : undefined;
            end();
            if (v !== undefined) apply(v);
          }}
          onPointerCancel={end}
          onLostPointerCapture={() => { if (press.current) end(); }}
          onBlur={() => { if (!press.current) end(); }}
          onKeyDown={(e) => {
            const from = live !== undefined ? live : now;
            let next: number | null;
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = stepDrag(dim, from, 1, setting.total);
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = stepDrag(dim, from, -1, setting.total);
            else if (e.key === 'Home') next = dragStep(dim);
            else if (e.key === 'End') next = null;
            else if (e.key === 'Enter') {
              e.preventDefault();
              if (live !== undefined) {
                const v = live;
                end();
                apply(v);
              }
              return;
            } else if (e.key === 'Escape' && live !== undefined) {
              e.preventDefault();
              e.stopPropagation();
              end();
              return;
            } else return;
            e.preventDefault();
            setKeyed(true);
            setLive(next);
          }} />
      </div>
    </div>
  );
}

/** Setting one resource's limit, opened from its bar; also the spike settings, which all limits share. */
function LimitEditor({ dim, label, total, r, run, onClose }: { dim: string; label: string; total: number; r: ResourcesInfo; run: (action: () => Promise<unknown>) => Promise<void>; onClose: () => void }) {
  const current = r.limits[dim];
  const [value, setValue] = useState(current === undefined ? '' : limitText(dim, current));
  const [avg, setAvg] = useState(String(r.settings.averageSec));
  const [margin, setMargin] = useState(String(r.settings.marginPoints));
  const [over, setOver] = useState(String(Math.round(r.settings.overSec)));
  const memory = dim === 'ram' || dim.startsWith('vram:');
  const save = (v: number | null) => void run(() => api.setResourceLimit(dim, v)).then(onClose);
  // An empty field is no limit, as the slider at its right end (issue #295); undefined: what is typed can't be a limit.
  const target = value.trim() === '' ? null : parseLimitInput(dim, value);
  const max = dragMax(dim, total);
  // On a phone the slider is the way in, so the number field doesn't take the focus and pop the keyboard up (point 8).
  const finePointer = typeof matchMedia !== 'function' || matchMedia('(pointer: fine)').matches;
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && target !== undefined) save(target);
    if (e.key === 'Escape') onClose();
  };
  return (
    <div className="limit-editor" role="group" aria-label={`Limit for ${label}`}>
      <label className="limit-editor-label" htmlFor="resource-limit-input">Limit for {label}, for the whole PC</label>
      <div className="limit-editor-row limit-slider-row">
        <input type="range" className="limit-slider" min={dragStep(dim)} max={max} step={dragStep(dim)}
          value={target === null || target === undefined ? max : Math.min(max, target)}
          aria-label={`Limit for ${label}`} aria-valuetext={target === undefined ? 'Not a limit' : dragText(dim, target)}
          onChange={(e) => {
            const v = Number(e.target.value);
            setValue(v >= max ? '' : String(v));
          }}
          onKeyDown={keys} />
        <span className="limit-slider-value">{target === undefined ? '–' : dragText(dim, target)}</span>
      </div>
      <div className="limit-editor-row">
        <input id="resource-limit-input" type="number" min={memory ? 0.5 : 1} max={memory ? undefined : 100} step={memory ? 0.5 : 1} value={value} autoFocus={finePointer}
          placeholder="none" onChange={(e) => setValue(e.target.value)} onKeyDown={keys} />
        <span>{memory ? 'GB' : '%'}</span>
        <button type="button" className="small" disabled={target === undefined} onClick={() => target !== undefined && save(target)}>Set</button>
        <button type="button" className="small" onClick={() => save(null)}>No limit</button>
        <button type="button" className="small link" onClick={onClose}>Cancel</button>
      </div>
      <p className="muted small-print">New heavy work waits while the PC's {r.settings.averageSec}-second average plus what is reserved would go above it. Running jobs only keep to their own reservation.</p>
      <details>
        <summary>Spikes (all limits)</summary>
        <div className="limit-editor-row">
          <label>Average over <input type="number" min={5} max={600} value={avg} onChange={(e) => setAvg(e.target.value)} /> s</label>
          <label>margin <input type="number" min={0} max={100} value={margin} onChange={(e) => setMargin(e.target.value)} /> points</label>
          <label>over for <input type="number" min={5} max={3600} value={over} onChange={(e) => setOver(e.target.value)} /> s</label>
          <button type="button" className="small" onClick={() => void run(() => api.setResourceSettings({ averageSec: Number(avg), marginPoints: Number(margin), overSec: Number(over) }))}>Save</button>
        </div>
        <p className="muted small-print">A running job counts as over its share when its average stays above its reservation plus the margin (memory: 10% of it, at least 0.5 GB) for that long.</p>
      </details>
    </div>
  );
}

/** One going job: what it reserved and uses, its state, and the person's Pause, Resume and Stop. */
function JobCard({ job, r, title, onOpen, run }: { job: ResourcesInfo['jobs'][number]; r: ResourcesInfo; title: string; onOpen: () => void; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const label = (dim: string) => dimLabel(dim, (id) => r.gpus.find((g) => g.id === id && !g.main)?.name ?? null);
  const dims = Object.keys(job.granted);
  // One request at a time from this card: a double-click on Pause suspended a job twice (acceptance test, finding 1).
  const [busy, setBusy] = useState(false);
  const act = (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    void run(action).finally(() => setBusy(false));
  };
  const state = job.state === 'over'
    ? `Over its share${job.overSince ? ` for ${overFor(Date.now() - job.overSince)}` : ''}: priority ${job.lowered ? 'lowered' : 'unchanged'}, session held, told`
    : job.state === 'paused' ? 'Paused by you: its processes are suspended; their memory stays taken' : 'Going';
  // One line a job, the full card a click away; over its share it stays open, since that needs the person (issue #284).
  const [expanded, setExpanded] = useState(false);
  if (!jobOpen(job) && !expanded) {
    const use = jobUse(job);
    const usage = dims.map((d) => `${label(d)} ${formatDim(d, job.using[d] ?? 0)} of ${formatDim(d, job.granted[d] ?? 0)}`).join(', ');
    return (
      <li className={`job-row ${job.state}`}>
        <button type="button" className="job-row-button" aria-expanded={false} onClick={() => setExpanded(true)}
          title={`${title}: ${job.what}. ${state}. Using ${usage || 'nothing reserved'}. Click for Pause, Resume and Stop.`}>
          <span className="job-row-mark" aria-hidden="true">{job.state === 'paused' ? '❚❚' : '●'}</span>
          <span className="job-row-who">{title}</span>
          <span className="job-what">{job.what}</span>
          <span className="job-track job-row-track" aria-label={`${Math.round(use.share * 100)}% of its reservation used`}>
            <span className={`job-fill${use.over ? ' over' : ''}`} style={{ width: `${(Math.min(1.5, use.share) / 1.5) * 100}%` }} />
            <span className="job-mark" style={{ left: `${100 / 1.5}%` }} />
          </span>
        </button>
      </li>
    );
  }
  return (
    <li className={`job-card ${job.state}`}>
      <div className="job-card-head">
        <button className="link" onClick={onOpen}>{title}</button>
        <span className="job-what">{job.what}</span>
        {expanded && !jobOpen(job) && <button type="button" className="small link job-fold" aria-expanded={true} title="Back to one line" onClick={() => setExpanded(false)}>▴</button>}
      </div>
      {dims.map((d) => {
        const g = job.granted[d] ?? 0;
        const u = job.using[d] ?? 0;
        const part = g > 0 ? Math.min(1.5, u / g) : 0;
        return (
          <div key={d} className="job-dim" title={`${label(d)}: using ${formatDim(d, u)} of ${formatDim(d, g)} reserved`}>
            <span>{label(d)}</span>
            <span className="job-track">
              <span className={`job-fill${u > g ? ' over' : ''}`} style={{ width: `${(part / 1.5) * 100}%` }} />
              <span className="job-mark" style={{ left: `${100 / 1.5}%` }} />
            </span>
            <span className="muted">{formatDim(d, u)} / {formatDim(d, g)}</span>
          </div>
        );
      })}
      <div className="job-state">
        {job.state === 'over' ? '▲ ' : job.state === 'paused' ? '❚❚ ' : '● '}{state}
        {job.loweredStays ? "; stays lowered until the job ends (this OS doesn't let Ledung raise it)" : ''}
        {job.learnedRuns ? ` · learned from ${job.learnedRuns} runs` : ''}
      </div>
      {job.state === 'over' && <div className="muted small-print">A lower priority only shares out CPU time; for memory and the GPU, the session's own cut-back is what helps.</div>}
      <div className="job-actions">
        {job.state === 'paused'
          ? <button className="small" disabled={busy} onClick={() => act(() => api.pauseJob(job.id, false))}>Resume</button>
          : <button className="small" disabled={busy} title="Suspends the job's processes; their memory and GPU memory stay taken" onClick={() => act(() => api.pauseJob(job.id, true))}>Pause</button>}
        <button className="small danger" disabled={busy} onClick={() => {
          if (confirm(`Stop "${job.what}"? Its ${job.processes} process${job.processes === 1 ? '' : 'es'} will be ended, and the session told.`)) act(() => api.stopJob(job.id));
        }}>Stop</button>
        {busy && <span className="muted">Working…</span>}
      </div>
    </li>
  );
}

export function MachinePanel(props: {
  machine: MachineInfo | null;
  /** The sessions by id (issue #233). */
  byId: ReadonlyMap<string, SessionInfo>;
  onOpen: (id: string) => void;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const m = props.machine;
  const [limit, setLimit] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => setLimit(m ? String(m.limit) : ''), [m?.limit]);
  // The person's open or fold of "Waiting for room"; null: as waitingOpen says. Forgotten when the list empties.
  const [lineOpen, setLineOpen] = useState<boolean | null>(null);
  const waits = m?.resources?.line.length ?? 0;
  useEffect(() => {
    if (!waits) setLineOpen(null);
  }, [waits]);
  if (!m) return null;
  const r = m.resources;
  const lineShown = lineOpen ?? (r ? waitingOpen(r.line, Date.now()) : false);
  const main = r?.gpus.find((g) => g.main) ?? null;
  const others = r?.gpus.filter((g) => !g.main) ?? [];
  const toggle = (dim: string) => setEditing((d) => (d === dim ? null : dim));
  const share = (dim: string, total: number) => (r ? limitShare(r.limits[dim], dim, total) : null);
  const reservedShare = (dim: string, total: number) => (r && total > 0 ? (r.reserved[dim] ?? 0) / (dim === 'cpu' || dim.startsWith('gpu:') ? 100 : total) : 0);
  // Dragging a limit line saves at once, through the same route as the editor (issue #295, point 3).
  const setting = (dim: string, total: number) => (r ? { value: limitUnits(dim, r.limits[dim]), total, set: (v: number | null) => props.run(() => api.setResourceLimit(dim, v)) } : undefined);
  const totalOf = (dim: string) => (dim === 'ram' ? m.memTotal : dim.startsWith('vram:') ? r?.gpus.find((g) => `vram:${g.id}` === dim)?.vramTotal ?? 0 : 100);
  const labelOf = (dim: string) => (r ? dimLabel(dim, (id) => r.gpus.find((g) => g.id === id && !g.main)?.name ?? null) : dim);
  const gpuBars = (g: NonNullable<typeof main>) => (
    <>
      <Load label={g.main ? 'GPU' : g.name} used={g.load} total={100} text={`${Math.round(g.load)}% load${g.main && others.length ? ` · ${g.name}` : ''}`}
        dim={`gpu:${g.id}`} limit={share(`gpu:${g.id}`, 100)} reserved={reservedShare(`gpu:${g.id}`, 100)} open={editing === `gpu:${g.id}`} onOpen={toggle} setting={setting(`gpu:${g.id}`, 100)} />
      {g.vramTotal !== null && g.vramUsed !== null && (
        <Load label={g.main ? 'GPU memory' : `${g.name} memory`} used={g.vramUsed} total={g.vramTotal} text={`${formatBytes(g.vramUsed)} of ${formatBytes(g.vramTotal)}`}
          dim={`vram:${g.id}`} limit={share(`vram:${g.id}`, g.vramTotal)} reserved={reservedShare(`vram:${g.id}`, g.vramTotal)} open={editing === `vram:${g.id}`} onOpen={toggle} setting={setting(`vram:${g.id}`, g.vramTotal)} />
      )}
    </>
  );
  const commit = () => {
    const n = Number(limit);
    if (n !== m.limit) void props.run(() => api.setLimit(n)).finally(() => setLimit(String(m.limit)));
  };
  const title = (id: string) => props.byId.get(id)?.title ?? 'a session';
  return (
    <section className="machine" aria-label="Machine">
      <div className="limits">
        <Load label="CPU" used={m.cores} total={m.cpus} text={`${formatCores(m.cores)} of ${m.cpus}`}
          {...(r ? { dim: 'cpu', limit: share('cpu', 100), reserved: reservedShare('cpu', 100), open: editing === 'cpu', onOpen: toggle, setting: setting('cpu', 100) } : {})} />
        <Load label="Memory" used={m.memUsed} total={m.memTotal} text={`${formatBytes(m.memUsed)} of ${formatBytes(m.memTotal)}`}
          {...(r ? { dim: 'ram', limit: share('ram', m.memTotal), reserved: reservedShare('ram', m.memTotal), open: editing === 'ram', onOpen: toggle, setting: setting('ram', m.memTotal) } : {})} />
        {main && gpuBars(main)}
        {m.docker && (
          <Load label="Docker memory" used={m.docker.memUsed} total={m.docker.memTotal}
            text={`${formatBytes(m.docker.memUsed)} of ${formatBytes(m.docker.memTotal)} · ${formatCores(m.docker.cores)}`} />
        )}
      </div>
      {r && editing && <LimitEditor key={editing} dim={editing} label={labelOf(editing)} total={totalOf(editing)} r={r} run={props.run} onClose={() => setEditing(null)} />}
      {others.length > 0 && (
        <details className="other-gpus">
          <summary>Other GPUs ({others.length})</summary>
          <div className="limits">{others.map((g) => <span key={g.id} style={{ display: 'contents' }}>{gpuBars(g)}</span>)}</div>
        </details>
      )}
      {r?.gpuNote && <div className="machine-note muted">{r.gpuNote}</div>}
      <div className="machine-working">
        <span><strong>{m.working}</strong> of </span>
        <input
          type="number" min={1} max={100} value={limit} aria-label="How many sessions may work at once"
          title="How many sessions may work at the same time. Managers don't count."
          onChange={(e) => setLimit(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span> working{m.line.length ? ` · ${m.line.length} waiting` : ''}</span>
      </div>
      {m.line.length > 0 && (
        <ol className="machine-line">
          {m.line.map((id) => {
            const s = props.byId.get(id);
            return (
              <li key={id}>
                <button className="link" onClick={() => props.onOpen(id)}>{title(id)}</button>
                {s && s.priority !== 'normal' && <span className={`chip prio-${s.priority}`}>{PRIORITY_LABEL[s.priority]}</span>}
                <button className="small" title="Start this turn now, above the limit" onClick={() => void props.run(() => api.startNow(id))}>Start now</button>
              </li>
            );
          })}
        </ol>
      )}
      {r && r.line.length > 0 && (
        <>
          {/* Folded to its count, unless something has waited over a minute (issue #284); a click opens or folds it. */}
          <button type="button" className="machine-sub machine-sub-toggle" aria-expanded={lineShown}
            title={lineShown ? 'Fold the list' : 'Show what is waiting'} onClick={() => setLineOpen(!lineShown)}>
            {lineShown ? '▾' : '▸'} Waiting for room · {r.line.length}
          </button>
          {lineShown && <ol className="machine-line resource-line">
            {r.line.map((w) => (
              <li key={w.id}>
                <button className="link" onClick={() => props.onOpen(w.sessionId)}>{title(w.sessionId)}</button>
                {w.kind === 'job' && <span className="job-what">{w.what}</span>}
                <span className="muted resource-reason">{w.reason}</span>
                <button className="small" title="Let it go now, above the limits" onClick={() => void props.run(() => api.resourceStartNow(w.id))}>Start now</button>
              </li>
            ))}
          </ol>}
        </>
      )}
      {r && (r.jobs.length > 0 || r.unreserved.length > 0) && (
        <>
          <div className="machine-sub">Jobs · {r.jobs.length + r.unreserved.length}</div>
          <ul className="job-cards">
            {r.jobs.map((j) => <JobCard key={j.id} job={j} r={r} title={title(j.sessionId)} onOpen={() => props.onOpen(j.sessionId)} run={props.run} />)}
            {r.unreserved.map((u) => (
              <li key={u.sessionId} className="job-card over">
                <div className="job-card-head"><button className="link" onClick={() => props.onOpen(u.sessionId)}>Unreserved: {title(u.sessionId)}</button></div>
                <div className="job-state">▲ Heavy work without a reservation: {u.overDims.map((d) => `${formatDim(d, u.using[d] ?? 0)} ${labelOf(d)}`).join(', ')}; priority {u.lowered ? 'lowered' : 'unchanged'}, session held, told</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** What each turn of a session used: two small charts (CPU, memory) and a table. */
export function SessionTurns({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<TurnResource[] | null>(null);
  useEffect(() => {
    let current = true;
    // Not while the page is hidden (issue #233).
    const stop = pollWhileShown(() => api.turns(sessionId).then((t) => current && setTurns(t), () => {}), 15000);
    return () => {
      current = false;
      stop();
    };
  }, [sessionId]);
  if (!turns) return null;
  if (!turns.length) return <><h3>Machine use per turn</h3><p className="muted">No turns measured yet.</p></>;
  const shown = turns.slice(-60);
  return (
    <>
      <h3>CPU per turn</h3>
      <MiniBars values={shown.map((t) => ({ value: t.peakCores, label: `${new Date(t.startedAt).toLocaleTimeString()}: peak ${formatCores(t.peakCores)}, average ${formatCores(t.avgCores)}` }))} format={formatCores} />
      <h3>Memory per turn</h3>
      <MiniBars values={shown.map((t) => ({ value: t.peakMem, label: `${new Date(t.startedAt).toLocaleTimeString()}: peak ${formatBytes(t.peakMem)}` }))} format={formatBytes} />
      <div className="table-scroll">
        <table className="plain calls">
          <thead>
            <tr><th>Started</th><th className="num">Took</th><th className="num">Avg CPU</th><th className="num">Peak CPU</th><th className="num">Peak memory</th><th>Commands</th></tr>
          </thead>
          <tbody>
            {turns.slice().reverse().map((t) => (
              <tr key={t.startedAt}>
                <td className="nowrap">{new Date(t.startedAt).toLocaleTimeString()}</td>
                <td className="num">{formatDuration(t.durationMs)}</td>
                <td className="num">{t.avgCores.toFixed(2)}</td>
                <td className="num">{t.peakCores.toFixed(2)}</td>
                <td className="num">{formatBytes(t.peakMem)}</td>
                <td className="mono">{t.commands.join(', ') || <span className="muted">none</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** One series of thin bars with a hover title; the peak is labelled. */
function MiniBars({ values, format }: { values: { value: number; label: string }[]; format: (n: number) => string }) {
  const max = Math.max(...values.map((v) => v.value), 0);
  return (
    <div className="mini-bars" role="img" aria-label={`Highest: ${format(max)}`}>
      <span className="mini-max muted">{format(max)}</span>
      {values.map((v, i) => (
        <div key={i} className="mini-col" title={v.label}>
          <div className="mini-bar" style={{ height: `${max > 0 ? Math.max(2, (v.value / max) * 100) : 0}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Typical costs per project and kind of command (step 6c), on the usage page. */
export function TypicalCosts() {
  const [costs, setCosts] = useState<TypicalCost[] | null>(null);
  useEffect(() => {
    api.typicalCosts(30).then(setCosts, () => setCosts([]));
  }, []);
  return (
    <section>
      <h2>Typical machine use per turn</h2>
      <p className="muted">Last 30 days, sessions only (not managers): what a turn that ran each kind of command usually used. Ledung learns these; they don't decide anything yet.</p>
      <p className="muted">CPU is in cores (threads) in use, never more than the machine has. Avg CPU: a turn's CPU time over its length, averaged over the turns. Peak CPU: the highest reading in each turn (one every few seconds), averaged over the turns, so it is what a turn's busiest moment usually reaches, not the highest ever seen.</p>
      {!costs ? <p className="muted">Loading…</p> : !costs.length ? <p className="muted">No turns measured yet.</p> : (
        <div className="table-scroll">
          <table className="plain">
            <thead>
              <tr><th>Project</th><th>Command</th><th className="num">Turns</th><th className="num">Avg CPU</th><th className="num">Peak CPU</th><th className="num">Peak memory</th><th className="num">Duration</th></tr>
            </thead>
            <tbody>
              {costs.slice(0, 50).map((c) => (
                <tr key={`${c.project} ${c.command}`}>
                  <td>{projectLabel(c.project)}</td>
                  <td className="mono">{c.command || <span className="muted">no commands</span>}</td>
                  <td className="num">{c.turns}</td>
                  <td className="num">{formatCores(c.avgCores)}</td>
                  <td className="num">{formatCores(c.peakCores)}</td>
                  <td className="num">{formatBytes(c.peakMem)}</td>
                  <td className="num">{formatDuration(c.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
