// The anonymous daily check-in (#220): the notice above the page, answered once, and the switch in Settings → About.
import { CHECKIN_WHAT, noticeText, statusLine } from '../checkIn.ts';
import { useCheckIn } from '../useCheckIn.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;

/** Above the page until OK or Turn off; either answer is kept by Ledung, so it does not come back. */
export function CheckInNotice({ run }: { run: Run }) {
  const { view, act } = useCheckIn();
  if (!view?.notice) return null;
  return (
    <div className="banner install">
      <span>{noticeText(view)}</span>
      <button className="small primary" onClick={() => void run(() => act('seen'))}>OK</button>
      {view.on && !view.doNotTrack && <button className="small" onClick={() => void run(() => act('off'))}>Turn off</button>}
    </div>
  );
}

/** Settings → About → Usage count: the switch, what is sent, word for word, and where. */
export function CheckInSettings({ run }: { run: Run }) {
  const { view, act } = useCheckIn();
  if (!view) return null;
  return (
    <>
      <h3>Usage count</h3>
      <label className="toggle">
        <input type="checkbox" checked={view.on} onChange={(e) => void run(() => act(e.target.checked ? 'on' : 'off'))} /> Count me: send the anonymous daily check-in
      </label>
      <p className="muted">{CHECKIN_WHAT}</p>
      <p className="muted">{statusLine(view)}</p>
      <p className="muted">What is sent, to <code>{view.url}</code>:</p>
      <pre className="checkin-payload">{JSON.stringify(view.payload, null, 2)}</pre>
    </>
  );
}
