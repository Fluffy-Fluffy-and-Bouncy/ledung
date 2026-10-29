// Machine resources (step 6): the load of this computer and Docker's VM, how many sessions work and
// the limit (editable), the line for a free place with Start now, and what one session's turns used.
import { useEffect, useState } from 'react';
import { projectLabel, type MachineInfo, type Priority, type SessionInfo, type TurnResource, type TypicalCost } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';

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

/** A load meter: status colour with an icon and words, never colour alone. */
function Load({ label, used, total, text }: { label: string; used: number; total: number; text: string }) {
  const share = total > 0 ? used / total : 0;
  const cls = share >= 0.95 ? 'critical' : share >= 0.8 ? 'warning' : 'good';
  const icon = { good: '●', warning: '▲', critical: '■' }[cls];
  return (
    <div className="limit" title={`${label}: ${text}${cls === 'good' ? '' : cls === 'warning' ? ' (busy)' : ' (full)'}`}>
      <div className="limit-head">
        <span>{label}</span>
        <span className={`limit-status ${cls}`}>{icon} {Math.round(share * 100)}%</span>
      </div>
      <div className="limit-track"><div className={`limit-fill ${cls}`} style={{ width: `${Math.min(100, share * 100)}%` }} /></div>
      <div className="limit-sub muted">{text}</div>
    </div>
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
  useEffect(() => setLimit(m ? String(m.limit) : ''), [m?.limit]);
  if (!m) return null;
  const commit = () => {
    const n = Number(limit);
    if (n !== m.limit) void props.run(() => api.setLimit(n)).finally(() => setLimit(String(m.limit)));
  };
  const title = (id: string) => props.sessions.find((s) => s.id === id)?.title ?? 'a session';
  return (
    <section className="machine" aria-label="Machine">
      <div className="limits">
        <Load label="CPU" used={m.cores} total={m.cpus} text={`${formatCores(m.cores)} of ${m.cpus}`} />
        <Load label="Memory" used={m.memUsed} total={m.memTotal} text={`${formatBytes(m.memUsed)} of ${formatBytes(m.memTotal)}`} />
        {m.docker && (
          <Load label="Docker memory" used={m.docker.memUsed} total={m.docker.memTotal}
            text={`${formatBytes(m.docker.memUsed)} of ${formatBytes(m.docker.memTotal)} · ${formatCores(m.docker.cores)}`} />
        )}
      </div>
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
