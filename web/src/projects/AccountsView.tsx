// Claude accounts (projects and accounts, P3): the accounts Ledung knows, who each is logged in as,
// which projects use it, the accounts for chats and new projects (issue #283), and adding one. Each is a
// sign-in folder the user signs in to with Claude Code's own /login, and only the sign-in: conversations, skills
// and settings are shared by every session whatever its account. Ledung takes no tokens (issue #342).
import { useState } from 'react';
import type { AccountChoices, AccountInfoView, ProjectInfo } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { formatTime } from '../components/MessageList.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;
export type DefaultIdentity = { email: string | null; organization: string | null; plan: string | null; seenAt: number | null } | null;

function who(a: { email: string | null; organization: string | null; plan: string | null; seenAt: number | null } | null): string {
  if (!a || (!a.email && !a.organization)) return 'not seen yet: shown after its first session starts';
  return [a.email, a.organization, a.plan].filter(Boolean).join(' · ') + (a.seenAt ? ` (seen ${formatTime(a.seenAt)})` : '');
}

export function AccountsSettings(props: { accounts: AccountInfoView[]; choices: AccountChoices; defaultIdentity: DefaultIdentity; configFileProblems: string[]; projects: ProjectInfo[]; run: Run; remote?: boolean }) {
  const typing = usePlainTyping();
  const [name, setName] = useState('');
  const [containerDir, setContainerDir] = useState('');
  const [added, setAdded] = useState<AccountInfoView | null>(null);
  const usedBy = (account: string | null) => [...props.projects.filter((p) => p.account === account).map((p) => p.name), ...(props.choices.chats === account ? ['chats'] : [])].join(', ') || 'no project';
  const choice = (which: keyof AccountChoices) => (
    <select value={props.choices[which] ?? ''} onChange={(e) => void props.run(() => api.setAccountChoices({ [which]: e.target.value || null }))}>
      <option value="">default: this computer's own login</option>
      {props.accounts.map((a) => <option key={a.name} value={a.name}>{a.name}{a.email ? ` (${a.email})` : ''}</option>)}
    </select>
  );

  return (
    <section>
      <h3>Accounts</h3>
      <p className="muted">Each project uses one account, for its manager and all its sessions; chats use the one chosen below. Ledung never moves work between accounts. Accounts can also be listed under <span className="mono">claudeAccounts</span> in the config file (see ledung.config.example.json).</p>
      {props.configFileProblems.map((p) => <div key={p} className="banner">{p}</div>)}
      <div>
        <table className="plain">
          <thead><tr><th>Account</th><th>Logged in as</th><th>Used by</th><th /></tr></thead>
          <tbody>
            <tr>
              <td><strong>default</strong><div className="muted">this computer's own Claude Code login</div></td>
              <td>{who(props.defaultIdentity)}</td>
              <td>{usedBy(null)}</td>
              <td />
            </tr>
            {props.accounts.map((a) => (
              <tr key={a.name}>
                <td>
                  <strong>{a.name}</strong>
                  {a.whatItIsFor && <div>{a.whatItIsFor}</div>}
                  {a.inConfigFile && <div className="muted">set in the config file: to remove it for good, take it out there too, or it comes back at the next start</div>}
                  <div className="muted">sign-in folder <span className="mono">{a.configDir}</span></div>
                  <div className="muted">in containers <span className="mono">{a.containerDir ?? `~/.ledung-accounts/${a.name}`}</span></div>
                </td>
                <td>{who(a)}</td>
                <td>{usedBy(a.name)}</td>
                <td className="account-actions">
                  {/* Opens Finder or Explorer on the computer Ledung runs on, so not from a phone (issue #414). */}
                  <button className="small" disabled={props.remote} title={props.remote ? 'Only on the computer Ledung runs on' : `Show ${a.configDir}`}
                    onClick={() => void props.run(() => api.openAccountFolder(a.name))}>Open folder</button>
                  <button className="small" onClick={() => void props.run(() => api.removeAccount(a.name))}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="form">
          <label>Account for chats <span className="muted">(new chats run on it; a running chat keeps its account until it restarts)</span>
            {choice('chats')}
          </label>
          <label>Account for new projects <span className="muted">(chosen for you in Add project)</span>
            {choice('newProjects')}
          </label>
        </div>

        <h4>Add an account</h4>
        <div className="form">
          <label>Name <span className="muted">(e.g. personal, work)</span>
            <input {...typing} value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
          </label>
          <label>Sign-in folder in containers <span className="muted">(optional; default ~/.ledung-accounts/&lt;name&gt; in the container user's home, or a mounted folder so the sign-in survives a rebuild)</span>
            <input {...typing} value={containerDir} onChange={(e) => setContainerDir(e.target.value)} className="mono" placeholder="~/.ledung-accounts/name" />
          </label>
          <p className="muted">
            Ledung makes a folder for this account's Claude Code sign-in, and only that: conversations, memory, skills and settings stay the same for every account, so moving a project to another account changes only whose plan and limits it uses.
            After adding it, sign in once with Claude Code's own <span className="mono">/login</span> as shown (for a container project,
            inside the container). Ledung never sees or keeps a sign-in token.
          </p>
          <button
            className="primary"
            disabled={!name.trim()}
            onClick={() => void props.run(async () => {
              setAdded(await api.addAccount({ name: name.trim(), ...(containerDir.trim() ? { containerDir: containerDir.trim() } : {}) }));
              setContainerDir('');
              setName('');
            })}
          >Add account</button>
        </div>
        {added && (
          <div className="banner">
            Added <strong>{added.name}</strong>. Choose it in a project's settings (⚙ next to the project), or above for chats and new projects.
            {' '}Now sign in once. In PowerShell:
            <pre className="mono">{`$env:CLAUDE_SECURESTORAGE_CONFIG_DIR="${added.configDir}"; claude`}</pre>
            (on macOS or Linux: <span className="mono">CLAUDE_SECURESTORAGE_CONFIG_DIR="{added.configDir}" claude</span>), then type <span className="mono">/login</span> and
            sign in with this account. For a container project, the same inside the container:
            <pre className="mono">{`docker exec -it <container> sh -c 'CLAUDE_SECURESTORAGE_CONFIG_DIR=${(added.containerDir ?? `~/.ledung-accounts/${added.name}`).replace(/^~\//, '$HOME/')} exec claude'`}</pre>
          </div>
        )}
      </div>
    </section>
  );
}
