// Away mode in the page (issue #35): "Away until HH:MM" allowing merge, dev ship or both (both by
// default), and Back. While away, a strip says so; it ends by itself at the time. It sits at the top
// right of a manager's header (issue #69); since issue #81 inside the header's ⚙ menu, with a marker
// beside the ⚙ while away. Computer control (issue #328) is a third choice, off by default, and Change… sets
// the time or the choices while away without pressing Back first (Martin, 2026-10-27, question #813).
import { useState } from 'react';
import { AWAY_DEFAULT, AWAY_KINDS, type AwayInfo, type AwayKind } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';

const KIND_LABEL: Record<AwayKind, string> = { merge: 'merge', devShip: 'dev ship', computerControl: 'computer control' };

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
/** A time field's value is HH:MM whatever the locale writes. */
const timeValue = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Beside a manager's ⚙ while away (issue #81): away stays in sight with the menu closed; a press opens the menu. */
export function AwayMarker({ away, onClick }: { away: AwayInfo; onClick: () => void }) {
  return (
    <button className="small away-marker" title="Away mode is on; open the session settings to end it" onClick={onClick}>
      Away until {hhmm(away.until)}
    </button>
  );
}

/** Above every view but a manager's while away (issue #274), with Back: away set elsewhere shows here too. */
export function AwayBanner({ away, run }: { away: AwayInfo; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const allowed = away.allow.length ? away.allow.map((k) => KIND_LABEL[k]).join(', ') : 'nothing';
  return (
    <div className="banner away" role="status">
      <span><strong>Away until {hhmm(away.until)}</strong> · managers may: {allowed}</span>
      <button className="small" title="End away mode now" onClick={() => void run(() => api.back())}>Back</button>
    </div>
  );
}

type Run = (action: () => Promise<unknown>) => Promise<void>;

/** The time and the choices: to go away, or to change them while away. */
function AwayForm({ initial, submit, run, close }: { initial: { until: string; allow: AwayKind[] }; submit: string; run: Run; close: () => void }) {
  const [until, setUntil] = useState(initial.until);
  const [allow, setAllow] = useState<AwayKind[]>(initial.allow);
  const toggle = (k: AwayKind) => setAllow((a) => (a.includes(k) ? a.filter((x) => x !== k) : AWAY_KINDS.filter((x) => x === k || a.includes(x))));
  return (
    <form
      className="away-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api.away(until, allow);
          close();
        });
      }}
    >
      <label>
        Away until <input type="time" value={until} onChange={(e) => setUntil(e.target.value)} required />
      </label>
      <span className="away-kinds">
        Managers may:
        {AWAY_KINDS.map((k) => (
          <label key={k}><input type="checkbox" checked={allow.includes(k)} onChange={() => toggle(k)} /> {KIND_LABEL[k]}</label>
        ))}
      </span>
      <p className="muted">Merge and dev ship only when every floor passes. Computer control lets managers take over this computer; they are told when it ends. Everything else waits for you.</p>
      <span className="away-actions">
        <button type="submit" className="primary small">{submit}</button>
        <button type="button" className="small" onClick={close}>Cancel</button>
      </span>
    </form>
  );
}

export function AwayPanel({ away, run }: { away: AwayInfo | null; run: Run }) {
  const [open, setOpen] = useState(false);

  if (away) {
    const allowed = away.allow.length ? away.allow.map((k) => KIND_LABEL[k]).join(', ') : 'nothing';
    return (
      <div className="away-entry">
        <div className="away-strip" role="status">
          <span>
            <strong>Away until {hhmm(away.until)}</strong> · allowed: {allowed}
          </span>
          <span className="away-actions">
            <button className={`small${open ? ' on' : ''}`} title="Change the time or what managers may do, and stay away" onClick={() => setOpen(!open)}>Change…</button>
            <button className="small" title="End away mode now" onClick={() => { setOpen(false); void run(() => api.back()); }}>Back</button>
          </span>
        </div>
        {open && <AwayForm initial={{ until: timeValue(away.until), allow: away.allow }} submit="Change" run={run} close={() => setOpen(false)} />}
      </div>
    );
  }
  const entry = (
    <button className={`small${open ? ' on' : ''}`} title="Let managers merge, dev ship or take over this computer without you while you're away" onClick={() => setOpen(!open)}>Away…</button>
  );
  return (
    <div className="away-entry">
      {entry}
      {open && <AwayForm initial={{ until: '08:00', allow: AWAY_DEFAULT }} submit="Start" run={run} close={() => setOpen(false)} />}
    </div>
  );
}
