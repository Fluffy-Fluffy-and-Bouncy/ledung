// What reserved jobs really used, by kind, and the commands Ledung knows are heavy (docs/steps/resource-limits.md,
// "Learning" and "Recognising heavy commands"): on the usage page, with Forget and "never needs a reservation".
import { useEffect, useState } from 'react';
import { projectLabel, type HeavyCommandInfo, type JobKindInfo } from '../../../src/shared/protocol.ts';
import { formatDim } from '../../../src/resources/limits.ts';
import { api } from '../api.ts';

/** Generic amounts ("cpu", "ram", "gpu", "vram"), as the learning store keeps them. */
function amounts(a: Record<string, number>): string {
  const label: Record<string, string> = { cpu: 'CPU', ram: 'memory', gpu: 'GPU', vram: 'GPU memory' };
  const parts = Object.entries(a).filter(([, v]) => v > 0).map(([d, v]) => `${formatDim(d === 'vram' ? 'vram:x' : d, v)} ${label[d] ?? d}`);
  return parts.length ? parts.join(', ') : '—';
}

export function ReservedJobs() {
  const [data, setData] = useState<{ kinds: JobKindInfo[]; commands: HeavyCommandInfo[] } | null>(null);
  const load = () => api.jobKinds().then(setData, () => setData({ kinds: [], commands: [] }));
  useEffect(() => {
    void load();
  }, []);
  const act = (action: () => Promise<unknown>) => void action().then(load, (e: Error) => alert(e.message));
  return (
    <section>
      <h2>Reserved jobs</h2>
      <p className="muted">What sessions' reserved jobs really used, by the name they gave them. From the third run on, a new reservation of that kind gets the learned figure (the 90th percentile of its busiest 30-second averages, plus the margin) instead of the session's guess.</p>
      {!data ? <p className="muted">Loading…</p> : !data.kinds.length ? <p className="muted">No reserved jobs yet.</p> : (
        <div className="table-scroll">
          <table className="plain">
            <thead>
              <tr><th>Project</th><th>Job</th><th className="num">Runs</th><th>Last asked</th><th>Learned</th><th className="num">Under-declared</th><th /></tr>
            </thead>
            <tbody>
              {data.kinds.map((k) => (
                <tr key={`${k.project} ${k.kind}`}>
                  <td>{projectLabel(k.project)}</td>
                  <td>{k.kind}</td>
                  <td className="num">{k.runs}</td>
                  <td>{amounts(k.asked)}</td>
                  <td>{amounts(k.learned)}</td>
                  <td className="num">{k.underDeclared || ''}</td>
                  <td><button className="small" title="Forget what this kind used: the next runs learn it again" onClick={() => {
                    if (confirm(`Forget what "${k.kind}" used?`)) act(() => api.forgetJobKind(k.project, k.kind));
                  }}>Forget</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Commands that need a reservation</h3>
      <p className="muted">Commands seen at least twice using more than unreserved work may. A session that runs one without a reservation is told to reserve first.</p>
      {!data ? null : !data.commands.length ? <p className="muted">None yet.</p> : (
        <div className="table-scroll">
          <table className="plain">
            <thead>
              <tr><th>Project</th><th>Command</th><th className="num">Seen</th><th>Usually uses</th><th /></tr>
            </thead>
            <tbody>
              {data.commands.map((c) => (
                <tr key={`${c.project} ${c.command}`} className={c.never ? 'muted' : ''}>
                  <td>{projectLabel(c.project)}</td>
                  <td className="mono">{c.command}</td>
                  <td className="num">{c.runs}</td>
                  <td>{amounts(c.peak)}</td>
                  <td>
                    <button className="small" onClick={() => act(() => api.markCommand(c.project, c.command, !c.never))}>
                      {c.never ? 'Needs one again' : 'Never needs one'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
