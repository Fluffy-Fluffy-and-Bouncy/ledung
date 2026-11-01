// Shortcuts that start Ledung (issue #415): the first-run question above the page, asked once, and Settings →
// Shortcuts for adding or removing them later. Start Ledung when I sign in (issue #456), offered once in the question
// and switched in Settings, and where the background log is. Stop Ledung (#456).
import { useState } from 'react';
import { inFrame } from '../computerFrame.ts';
import { SHORTCUT_ABOUT, asksFirstRun, questionText, settingsText } from '../shortcuts.ts';
import { useShortcuts } from '../useShortcuts.ts';
import { api } from '../api.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;

/**
 * Above the page until Yes or No; either answer is kept by Ledung, so it never comes back. The sign-in start is a
 * box beside it, off unless ticked, and applies with either answer (#456).
 */
export function ShortcutNotice({ run }: { run: Run }) {
  const { view, act } = useShortcuts();
  const [signIn, setSignIn] = useState(false);
  if (!view || !asksFirstRun(view, inFrame())) return null;
  const answer = (action: 'add' | 'decline') => run(async () => {
    await act(action);
    if (signIn) await act('sign-in-on');
  });
  return (
    <div className="banner install">
      <span>{questionText(view)} {SHORTCUT_ABOUT}</span>
      {view.signIn.available && !view.signIn.on && (
        <label className="toggle">
          <input type="checkbox" checked={signIn} onChange={(e) => setSignIn(e.target.checked)} /> {view.signIn.label}
        </label>
      )}
      <button className="small primary" onClick={() => void answer('add')}>Yes</button>
      <button className="small" onClick={() => void answer('decline')}>No</button>
    </div>
  );
}

/** Settings → Shortcuts: where each one is, with Add shortcuts and Remove; then Start at sign-in and the log. */
export function ShortcutSettings({ run }: { run: Run }) {
  const { view, act } = useShortcuts();
  if (!view) return null;
  const missing = view.places.filter((p) => !p.present);
  const present = view.places.filter((p) => p.present);
  return (
    <>
      <section>
        <h3>Shortcuts</h3>
        {!view.available ? <p className="muted">{view.reason}</p> : (
          <>
            <p className="muted">
              {settingsText(view)} {SHORTCUT_ABOUT} Ledung then runs in the background, with no window; Stop Ledung below stops it.
            </p>
            <ul className="shortcut-places">
              {view.places.map((p) => (
                <li key={p.id}><b>{p.label}</b> <span className="muted">{p.present ? 'added' : 'not there'}</span></li>
              ))}
            </ul>
            <div className="restart-confirm">
              {missing.length > 0 && <button className="small primary" onClick={() => void run(() => act('add'))}>Add shortcuts</button>}
              {present.length > 0 && <button className="small" onClick={() => void run(() => act('remove'))}>Remove</button>}
            </div>
          </>
        )}
      </section>
      <section>
        <h3>Start at sign-in</h3>
        {!view.signIn.available ? <p className="muted">{view.signIn.reason}</p> : (
          <>
            <label className="toggle" title={view.signIn.file ?? undefined}>
              <input type="checkbox" checked={view.signIn.on} onChange={(e) => void run(() => act(e.target.checked ? 'sign-in-on' : 'sign-in-off'))} /> {view.signIn.label}
            </label>
            <p className="muted">Ledung starts in the background, without opening its page; open it with the icon or the <code>ledung</code> command. Only for you, and no administrator rights are needed.</p>
          </>
        )}
      </section>
      <section>
        <h3>Log</h3>
        <p className="muted">
          {view.log.active ? "This Ledung runs in the background; what it says goes to" : 'Started in the background, Ledung writes what it says to'} <code>{view.log.file}</code>
          {view.log.active ? '.' : '. This one was started in a terminal or window, so it says it there.'}
        </p>
      </section>
    </>
  );
}

/**
 * Stop Ledung (issue #456), with a confirm: its sessions stop, as with Ctrl+C in its window. Only on this computer's
 * own page, the one place it can be started again from; elsewhere Ledung refuses it and this is not shown.
 */
export function StopSettings() {
  const { view } = useShortcuts();
  const [state, setState] = useState<'idle' | 'confirming' | 'stopped' | 'failed'>('idle');
  if (!view || inFrame()) return null;
  return (
    <section>
      <h3>Stop Ledung</h3>
      <p className="muted">Stops Ledung and its sessions; resume a session after the next start to continue it. Start Ledung again with its icon or the <code>ledung</code> command.</p>
      {state === 'stopped' ? <p>Ledung has stopped. This page stays as it was until Ledung runs again.</p>
        : state === 'confirming' ? (
          <span className="restart-confirm">
            <span className="muted">Running sessions stop.</span>
            <button className="small primary" onClick={async () => {
              try {
                await api.stopLedung();
                setState('stopped');
              } catch {
                setState('failed');
              }
            }}>Stop Ledung</button>
            <button className="small" onClick={() => setState('idle')}>Cancel</button>
          </span>
        ) : (
          <span className="restart-confirm">
            {state === 'failed' && <span className="restart-problem">Ledung refused to stop.</span>}
            <button className="small" onClick={() => setState('confirming')}>Stop Ledung</button>
          </span>
        )}
    </section>
  );
}
