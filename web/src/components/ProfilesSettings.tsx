// Settings' session profiles (#298): the profiles each workflow's projects get and where each comes from, the
// workflow's file or this computer's config, and a workflow's file that can't be used, so its projects quietly
// running on this computer's profiles never goes unseen. Each profile's allow rules are listed, so a loosening is
// visible (Martin, question #708), and its own MCP servers, which run commands. Read only: profiles are changed in the files.
import { useEffect, useState } from 'react';
import type { ProfileSource, ProfilesView } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { Where } from './SettingsFrame.tsx';

const SOURCE: Record<ProfileSource, string> = {
  workflow: 'workflow',
  computer: 'this computer',
  'workflow+computer': 'workflow, changed on this computer',
};

export function ProfilesSettings() {
  const [view, setView] = useState<ProfilesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.profiles().then(setView, (e: Error) => setError(e.message)); }, []);
  const several = (view?.groups.length ?? 0) > 1;
  return (
    <section>
      <div className="settings-h"><h3>Session profiles</h3><Where kind="config" /></div>
      <p className="muted">
        What managers and sessions get of your own Claude Code setup. A workflow's profiles file comes first; a profile of the same name in this computer's config changes it field by field. Read when each session starts.
      </p>
      {error && <p className="error">{error}</p>}
      {view?.groups.map((g) => (
        <div key={g.workflow ?? ''} className="profiles-group">
          {several && <h4>{g.workflow === null ? 'Chats and projects without a workflow\'s profiles' : `Workflow "${g.workflow}"`}</h4>}
          {g.file && <p className="muted">From <code>{g.file}</code></p>}
          {g.warning && <div className="board-warning" role="alert">{g.warning}</div>}
          <table className="plain">
            <thead><tr><th>Profile</th><th>From</th><th>About</th></tr></thead>
            <tbody>
              <tr><td>full</td><td>built in</td><td className="muted">Everything you have set up, as outside Ledung.</td></tr>
              {g.profiles.map((p) => (
                <tr key={p.name}><td>{p.name}</td><td>{SOURCE[p.source]}</td><td className="muted">
                  {p.about ?? ''}
                  {p.allow.length > 0 && <div>Allows without asking: {p.allow.map((r, i) => <span key={r}>{i ? ', ' : ''}<code>{r}</code></span>)}</div>}
                  {p.mcp.length > 0 && <div>Runs MCP servers: {p.mcp.map((m, i) => <span key={m}>{i ? ', ' : ''}<code>{m}</code></span>)}</div>}
                </td></tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Default for managers: {g.defaults.manager ?? 'full'} · for sessions: {g.defaults.session ?? 'full'}
            {g.pluginsOff.length > 0 && <> · plugins off where installed: {g.pluginsOff.join(', ')}</>}
          </p>
        </div>
      ))}
    </section>
  );
}
