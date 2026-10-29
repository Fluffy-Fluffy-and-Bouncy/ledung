// Shortcuts that start Ledung (issue #415): the first-run question above the page, asked once, and Settings →
// Shortcuts for adding or removing them later.
import { inFrame } from '../computerFrame.ts';
import { SHORTCUT_ABOUT, asksFirstRun, questionText, settingsText } from '../shortcuts.ts';
import { useShortcuts } from '../useShortcuts.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;

/** Above the page until Yes or No; either answer is kept by Ledung, so it never comes back. */
export function ShortcutNotice({ run }: { run: Run }) {
  const { view, act } = useShortcuts();
  if (!view || !asksFirstRun(view, inFrame())) return null;
  return (
    <div className="banner install">
      <span>{questionText(view)} {SHORTCUT_ABOUT}</span>
      <button className="small primary" onClick={() => void run(() => act('add'))}>Yes</button>
      <button className="small" onClick={() => void run(() => act('decline'))}>No</button>
    </div>
  );
}

/** Settings → Shortcuts: where each one is, with Add shortcuts and Remove. */
export function ShortcutSettings({ run }: { run: Run }) {
  const { view, act } = useShortcuts();
  if (!view) return null;
  const missing = view.places.filter((p) => !p.present);
  const present = view.places.filter((p) => p.present);
  return (
    <section>
      <h3>Shortcuts</h3>
      {!view.available ? <p className="muted">{view.reason}</p> : (
        <>
          <p className="muted">
            {settingsText(view)} {SHORTCUT_ABOUT}{' '}
            {view.kind === 'windows' ? 'Ledung then runs in a minimised window in the taskbar; closing that window stops it.' : 'Ledung then runs in a Terminal window; closing it stops Ledung.'}
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
  );
}
