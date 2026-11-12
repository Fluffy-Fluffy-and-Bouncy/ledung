// Machine resources (step 6): the load of this computer and Docker's VM, how many sessions work and
// the limit (editable), the line for a free place with Start now, and what one session's turns used.
import { useEffect, useState } from 'react';
import { projectLabel, type MachineInfo, type Priority, type ResourcesInfo, type SessionInfo, type TurnResource, type TypicalCost } from '../../../src/shared/protocol.ts';
import { dimLabel, formatDim } from '../../../src/resources/limits.ts';
import { api } from '../api.ts';
import { limitShare, limitText, overFor, parseLimitInput } from './resourceLimits.ts';

export function formatCores(n: number): string {
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${n >= 0.95 && n < 1.05 ? 'core' : 'cores'}`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export const PRIORITY_LABEL: Record<Priority, string> = { normal: 'Normal', high: 'High', critical: 'Critical' };

/**
 * A load meter: status colour with an icon and words, never colour alone. With resource limits (docs/steps/
 * resource-limits.md): what going jobs reserve but don't use yet hatched after the fill, the limit as a line, and a
 * click to set the limit (`dim`).
 */
function Load({ label, used, total, text, limit, reserved, dim, open, onOpen }: {
  label: string; used: number; total: number; text: string;
  /** The limit as a share of the bar (0–1); null: none. */
  limit?: number | null;
  reserved?: number;
  dim?: string;
  open?: boolean;
  onOpen?: (dim: string) => void;
}) {
  const share = total > 0 ? used / total : 0;
  const cls = share >= 0.95 ? 'critical' : share >= 0.8 ? 'warning' : 'good';
  const icon = { good: '●', warning: '▲', critical: '■' }[cls];
  const fill = Math.min(100, share * 100);
  const hatch = Math.max(0, Math.min(100 - fill, (reserved ?? 0) * 100));
  const limitPct = limit === null || limit === undefined ? null : Math.min(100, Math.max(0, limit * 100));
  const title = `${label}: ${text}${cls === 'good' ? '' : cls === 'warning' ? ' (busy)' : ' (full)'}${limitPct !== null ? ` · limit at ${Math.round(limitPct)}%` : ''}${hatch > 0 ? ` · ${Math.round(hatch)}% reserved` : ''}${dim ? ' · click to set its limit' : ''}`;
  const body = (
    <>
      <div className="limit-head">
        <span>{label}</span>
        <span className={`limit-status ${cls}`}>{icon} {Math.round(share * 100)}%</span>
      </div>
      <div className="limit-track resource-track">
        <div className={`limit-fill ${cls}`} style={{ width: `${fill}%` }} />
        {hatch > 0 && <div className="limit-reserved" style={{ left: `${fill}%`, width: `${hatch}%` }} />}
        {limitPct !== null && <div className="limit-line" style={{ left: `calc(${limitPct}% - 1px)` }} />}
      </div>
      <div className="limit-sub muted">{text}</div>
    </>
  );
  if (!dim || !onOpen) return <div className="limit" title={title}>{body}</div>;
  return (
    <button type="button" className={`limit limit-button${open ? ' open' : ''}`} title={title} aria-expanded={open}
      aria-label={`${label}: ${text}. ${limitPct !== null ? `Limit at ${Math.round(limitPct)}%.` : 'No limit.'} Set its limit.`} onClick={() => onOpen(dim)}>
      {body}
    </button>
  );
}

/** Setting one resource's limit, opened from its bar; also the spike settings, which all limits share. */
function LimitEditor({ dim, label, r, run, onClose }: { dim: string; label: string; r: ResourcesInfo; run: (action: () => Promise<unknown>) => Promise<void>; onClose: () => void }) {
  const current = r.limits[dim];
  const [value, setValue] = useState(current === undefined ? '' : limitText(dim, current));
  const [avg, setAvg] = useState(String(r.settings.averageSec));
  const [margin, setMargin] = useState(String(r.settings.marginPoints));
  const [over, setOver] = useState(String(Math.round(r.settings.overSec)));
  const memory = dim === 'ram' || dim.startsWith('vram:');
  const save = (v: number | null) => void run(() => api.setResourceLimit(dim, v)).then(onClose);
  const parsed = parseLimitInput(dim, value);
  return (
    <div className="limit-editor" role="group" aria-label={`Limit for ${label}`}>
      <label className="limit-editor-label" htmlFor="resource-limit-input">Limit for {label}, for the whole PC</label>
      <div className="limit-editor-row">
        <input id="resource-limit-input" type="number" min={memory ? 0.5 : 1} max={memory ? undefined : 100} step={memory ? 0.5 : 1} value={value} autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && parsed !== undefined) save(parsed);
            if (e.key === 'Escape') onClose();
          }} />
        <span>{memory ? 'GB' : '%'}</span>
        <button type="button" className="small" disabled={parsed === undefined} onClick={() => parsed !== undefined && save(parsed)}>Set</button>
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
  return (
    <li className={`job-card ${job.state}`}>
      <div className="job-card-head">
        <button className="link" onClick={onOpen}>{title}</button>
        <span className="job-what">{job.what}</span>
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
  sessions: SessionInfo[];
  onOpen: (id: string) => void;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const m = props.machine;
  const [limit, setLimit] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => setLimit(m ? String(m.limit) : ''), [m?.limit]);
  if (!m) return null;
  const r = m.resources;
  const main = r?.gpus.find((g) => g.main) ?? null;
  const others = r?.gpus.filter((g) => !g.main) ?? [];
  const toggle = (dim: string) => setEditing((d) => (d === dim ? null : dim));
  const share = (dim: string, total: number) => (r ? limitShare(r.limits[dim], dim, total) : null);
  const reservedShare = (dim: string, total: number) => (r && total > 0 ? (r.reserved[dim] ?? 0) / (dim === 'cpu' || dim.startsWith('gpu:') ? 100 : total) : 0);
  const labelOf = (dim: string) => (r ? dimLabel(dim, (id) => r.gpus.find((g) => g.id === id && !g.main)?.name ?? null) : dim);
  const gpuBars = (g: NonNullable<typeof main>) => (
    <>
      <Load label={g.main ? 'GPU' : g.name} used={g.load} total={100} text={`${Math.round(g.load)}% load${g.main && others.length ? ` · ${g.name}` : ''}`}
        dim={`gpu:${g.id}`} limit={share(`gpu:${g.id}`, 100)} reserved={reservedShare(`gpu:${g.id}`, 100)} open={editing === `gpu:${g.id}`} onOpen={toggle} />
      {g.vramTotal !== null && g.vramUsed !== null && (
        <Load label={g.main ? 'GPU memory' : `${g.name} memory`} used={g.vramUsed} total={g.vramTotal} text={`${formatBytes(g.vramUsed)} of ${formatBytes(g.vramTotal)}`}
          dim={`vram:${g.id}`} limit={share(`vram:${g.id}`, g.vramTotal)} reserved={reservedShare(`vram:${g.id}`, g.vramTotal)} open={editing === `vram:${g.id}`} onOpen={toggle} />
      )}
    </>
  );
  const commit = () => {
    const n = Number(limit);
    if (n !== m.limit) void props.run(() => api.setLimit(n)).finally(() => setLimit(String(m.limit)));
  };
  const title = (id: string) => props.sessions.find((s) => s.id === id)?.title ?? 'a session';
  return (
    <section className="machine" aria-label="Machine">
      <div className="limits">
        <Load label="CPU" used={m.cores} total={m.cpus} text={`${formatCores(m.cores)} of ${m.cpus}`}
          {...(r ? { dim: 'cpu', limit: share('cpu', 100), reserved: reservedShare('cpu', 100), open: editing === 'cpu', onOpen: toggle } : {})} />
        <Load label="Memory" used={m.memUsed} total={m.memTotal} text={`${formatBytes(m.memUsed)} of ${formatBytes(m.memTotal)}`}
          {...(r ? { dim: 'ram', limit: share('ram', m.memTotal), reserved: reservedShare('ram', m.memTotal), open: editing === 'ram', onOpen: toggle } : {})} />
        {main && gpuBars(main)}
        {m.docker && (
          <Load label="Docker memory" used={m.docker.memUsed} total={m.docker.memTotal}
            text={`${formatBytes(m.docker.memUsed)} of ${formatBytes(m.docker.memTotal)} · ${formatCores(m.docker.cores)}`} />
        )}
      </div>
      {r && editing && <LimitEditor key={editing} dim={editing} label={labelOf(editing)} r={r} run={props.run} onClose={() => setEditing(null)} />}
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
            const s = props.sessions.find((x) => x.id === id);
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
          <div className="machine-sub">Waiting for room · {r.line.length}</div>
          <ol className="machine-line resource-line">
            {r.line.map((w) => (
              <li key={w.id}>
                <button className="link" onClick={() => props.onOpen(w.sessionId)}>{title(w.sessionId)}</button>
                {w.kind === 'job' && <span className="job-what">{w.what}</span>}
                <span className="muted resource-reason">{w.reason}</span>
                <button className="small" title="Let it go now, above the limits" onClick={() => void props.run(() => api.resourceStartNow(w.id))}>Start now</button>
              </li>
            ))}
          </ol>
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
    const load = () => api.turns(sessionId).then((t) => current && setTurns(t), () => {});
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      current = false;
      clearInterval(timer);
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
