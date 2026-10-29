// "Install as app" (issue #350): the start notice, until installed or dismissed, and its place in Settings.
import { useInstallApp } from '../useInstallApp.ts';
import { Where } from './SettingsFrame.tsx';

type App = ReturnType<typeof useInstallApp>;
type Run = (action: () => Promise<unknown>) => Promise<void>;

const DOCK_HINT = <>In Safari, choose <b>File → Add to Dock</b>.</>;

/** Above the page, at first start: shown until the page is installed or "Not now" is pressed, which is remembered. */
export function InstallNotice({ app, run }: { app: App; run: Run }) {
  return (
    <div className="banner install">
      <span>Ledung can run as an app, in a window of its own.{app.install.kind === 'dock' && <> {DOCK_HINT}</>}</span>
      {app.install.kind === 'button' && <button className="small primary" onClick={() => void run(app.onInstall)}>Install as app</button>}
      <button className="small" onClick={app.onDismiss}>Not now</button>
    </div>
  );
}

/** Always in Settings: the button, Safari's hint, or why there is neither; nothing once it runs as an app. */
export function InstallSettings({ run }: { run: Run }) {
  const app = useInstallApp();
  const { install } = app;
  if (install.kind === 'none' && !install.reason) return null;
  return (
    <section>
      <div className="settings-h"><h3>App</h3><Where kind="browser" /></div>
      <p className="muted">Ledung in a window of its own, with its own icon, instead of a browser tab.</p>
      {install.kind === 'button' && <button className="primary" onClick={() => void run(app.onInstall)}>Install as app</button>}
      {install.kind === 'dock' && <p>{DOCK_HINT}</p>}
      {install.kind === 'none' && <p className="muted">{install.reason}</p>}
    </section>
  );
}
