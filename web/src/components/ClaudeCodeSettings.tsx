// Settings' Claude Code (issue #341): which Claude Code new sessions on this computer start (the user's own
// installed one), why none can when it is missing or too old, and what each running session was started with.
// Read only. The bundled copy is for the config alone ("claudeExecutable": "bundled") and isn't offered here.
import { useEffect, useState } from 'react';
import type { ClaudeCodeView, SessionInfo } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { PROGRAM_KIND, problemParts, runningPrograms } from '../claudeProgram.ts';

/** A problem's text with its commands as code and its address as a link (the page's banner too). */
export function ProblemText({ text }: { text: string }) {
  return <>{problemParts(text).map((p, i) => (p.kind === 'code' ? <code key={i}>{p.text}</code> : p.kind === 'link' ? <a key={i} href={p.text} target="_blank" rel="noreferrer">{p.text}</a> : p.text))}</>;
}

/** A table cell starts with a capital. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ClaudeCodeSettings({ sessions }: { sessions: SessionInfo[] }) {
  const [view, setView] = useState<ClaudeCodeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.claudeCode().then((v) => { setView(v); setError(null); }, (e: Error) => setError(e.message));
  useEffect(() => { void load(); }, []);
  const running = runningPrograms(sessions);
  const program = view?.program;
  return (
    <section>
      <h3>Claude Code</h3>
      <p className="muted">
        Ledung runs your Claude Code: the <code>claude</code> on the PATH or where its installer puts it
        {view?.required && <>, version {view.required} or newer (the one Ledung's Agent SDK was built for)</>}. Without it, sessions don't start.
        A running session keeps the program it started with.
      </p>
      {error && <p className="error">{error}</p>}
      {view?.problem && <div className="board-warning" role="alert"><ProblemText text={view.problem} /></div>}
      {view && (
        <table className="plain">
          <tbody>
            <tr><th>New sessions run</th><td>{program ? <>{cap(PROGRAM_KIND[program.kind])} {program.version && <>· {program.version}</>}<div className="muted mono">{program.path}</div></> : "Nothing: sessions don't start"}</td></tr>
            {view.installed && view.installed.path !== program?.path && (
              <tr><th>Found</th><td>{cap(PROGRAM_KIND[view.installed.kind])} · {view.installed.version ?? 'version unknown'}<div className="muted mono">{view.installed.path}</div></td></tr>
            )}
          </tbody>
        </table>
      )}
      <button onClick={() => void load()}>Check again</button>
      {running.length > 0 && (
        <>
          <h4>Running sessions</h4>
          <table className="plain">
            <thead><tr><th>Session</th><th>Runs</th><th>Version</th></tr></thead>
            <tbody>
              {running.map((r) => (
                <tr key={r.id}>
                  <td>{r.title}<div className="muted">{r.project}</div></td>
                  <td>{cap(r.runs)}{r.path && <div className="muted mono">{r.path}</div>}</td>
                  <td className="mono">{r.version ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
