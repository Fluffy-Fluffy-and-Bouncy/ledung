// Usage stops in Settings (issue #278): per account, the percent of the 5-hour and weekly windows at which Ledung
// holds new turns on that account; a reached stop can be lifted for the rest of its window.
import { useEffect, useState } from 'react';
import type { AccountInfoView, UsageStopInfo } from '../../../src/shared/protocol.ts';
import { meterStopLine } from '../../../src/shared/usage-stop-text.ts';
import { api } from '../api.ts';

const WINDOWS: [string, string][] = [['five_hour', '5-hour'], ['seven_day', 'Weekly']];
const nameOf = (kind: string) => WINDOWS.find(([k]) => k === kind)?.[1] ?? kind;

/** "Weekly usage reached the stop at 98% (now 98%): new turns are held until Thu 09:00." for the banner. */
export function usageStopLine(s: UsageStopInfo): string {
  const now = s.utilization != null ? ` (now ${Math.round(s.utilization * 100)}%)` : '';
  const until = s.resetsAt != null ? ` until ${new Date(s.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}, when the window resets` : '';
  return `${nameOf(s.kind)} usage${s.account === 'default' ? '' : ` of account ${s.account}`} reached the stop at ${s.percent}%${now}: new turns are held${until}.`;
}

/** Under a usage meter with a stop (issue #280): "93% · 2% to stop · Weekly limit resets in 11 h 30 min", or "Held at 95% · Weekly limit resets in 9 h" with Lift. */
export function MeterStopLine({ stop, run }: { stop: UsageStopInfo; run: (action: () => Promise<unknown>) => Promise<void> }) {
  // The countdown moves by the minute even when nothing else on the page changes.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className={`limit-stop${stop.holding ? ' held' : ''}`}>
      <span>{meterStopLine(stop, now)}</span>
      {stop.holding && <button className="small primary" onClick={() => void run(() => api.liftUsageStop(stop.account, stop.kind))}>Lift</button>}
    </div>
  );
}

export function UsageStopsSettings(props: { accounts: AccountInfoView[]; usageStops: UsageStopInfo[]; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const accounts = ['default', ...props.accounts.map((a) => a.name)];
  return (
    <section>
      <h3>Usage stops</h3>
      <p className="muted">At this share of a plan window, Ledung holds new turns for every session and manager on the account; a running turn finishes. It lifts when the window resets, when you raise the stop, or with Lift. Once saved here, these replace the config's <code>usageStops</code>.</p>
      {accounts.map((account) => (
        <div key={account}>
          {accounts.length > 1 && <strong>{account === 'default' ? 'This computer\'s login' : account}</strong>}
          {WINDOWS.map(([kind, label]) => {
            const stop = props.usageStops.find((s) => s.account === account && s.kind === kind);
            // Keyed by the stored level, so the field shows a level saved elsewhere (another tab, the config).
            return <StopRow key={`${kind}:${stop?.percent ?? ''}`} account={account} kind={kind} label={label} stop={stop} run={props.run} />;
          })}
        </div>
      ))}
    </section>
  );
}

function StopRow(props: { account: string; kind: string; label: string; stop?: UsageStopInfo; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [value, setValue] = useState(props.stop ? String(props.stop.percent) : '');
  const s = props.stop;
  const save = () => void props.run(() => api.setUsageStop(props.account, props.kind, value.trim() ? Number(value) : null));
  return (
    <div className="row" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
      <label>{props.label} <input type="number" min={1} max={100} placeholder="none" value={value} style={{ width: '5rem' }}
        onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save(); }} /> %</label>
      <button className="small" disabled={value.trim() === (s ? String(s.percent) : '')} onClick={save}>Save</button>
      {s?.holding && <button className="small primary" onClick={() => void props.run(() => api.liftUsageStop(props.account, props.kind))}>Lift</button>}
      <span className="muted">{s?.holding ? 'Reached: work is held.' : s?.lifted ? 'Reached, lifted for this window.' : s?.utilization != null ? `Now ${Math.round(s.utilization * 100)}%.` : ''}</span>
    </div>
  );
}
