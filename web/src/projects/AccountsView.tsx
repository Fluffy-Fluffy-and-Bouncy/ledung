// Claude accounts (projects and accounts, P3): the accounts Ledung knows, who each is logged in as,
// which projects use it, the accounts for chats and new projects (issue #283), and adding one. Each is a
// sign-in folder the user signs in to with Claude Code's own /login, and only the sign-in: conversations, skills
// and settings are shared by every session whatever its account. Ledung takes no tokens (issue #342): a long-lived
// token goes in through a command the user runs in their own terminal, and the page only shows that command (#85).
import { Fragment, useState } from 'react';
import type { AccountChoices, AccountInfoView, ProjectInfo, ShownSignIn } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { CopyButton } from '../components/Markdown.tsx';
import { formatTime } from '../components/MessageList.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';
import { signedInWith } from './signedInWith.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;
export type DefaultIdentity = { email: string | null; organization: string | null; plan: string | null; seenAt: number | null; signInKind?: ShownSignIn | null } | null;

function who(a: { email: string | null; organization: string | null; plan: string | null; seenAt: number | null } | null): string {
  if (!a || (!a.email && !a.organization)) return 'not seen yet: shown after its first session starts';
  return [a.email, a.organization, a.plan].filter(Boolean).join(' · ') + (a.seenAt ? ` (seen ${formatTime(a.seenAt)})` : '');
}

function CommandLine({ text }: { text: string }) {
  return <div className="sign-in-command"><code className="remote-record">{text}</code> <CopyButton text={text} /></div>;
}

/** The command for a long-lived token (#85), with what it does. */
function TokenCommand({ command }: { command: string }) {
  return (
    <>
      <p className="muted">With a long-lived token: get one with <span className="mono">claude setup-token</span>, then run this in your own terminal on this computer and paste it. It goes straight into Claude Code's sign-in; Ledung never receives it.</p>
      <CommandLine text={command} />
    </>
  );
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
              <td>{who(props.defaultIdentity)}<div className="muted">{signedInWith(props.defaultIdentity?.signInKind)}</div></td>
              <td>{usedBy(null)}</td>
              <td />
            </tr>
            {props.accounts.map((a) => (
              <Fragment key={a.name}>
              <tr>
                <td>
                  <strong>{a.name}</strong>
                  {a.whatItIsFor && <div>{a.whatItIsFor}</div>}
                  {a.inConfigFile && <div className="muted">set in the config file: to remove it for good, take it out there too, or it comes back at the next start</div>}
                  <div className="muted">sign-in folder <span className="mono">{a.configDir}</span></div>
                  <div className="muted">in containers <span className="mono">{a.containerDir ?? `~/.ledung-accounts/${a.name}`}</span></div>
                </td>
                <td>{who(a)}<div className="muted">{signedInWith(a.signInKind)}</div></td>
                <td>{usedBy(a.name)}</td>
                <td className="account-actions">
                  {/* Opens Finder or Explorer on the computer Ledung runs on, so not from a phone (issue #414). */}
                  <button className="small" disabled={props.remote} title={props.remote ? 'Only on the computer Ledung runs on' : `Show ${a.configDir}`}
                    onClick={() => void props.run(() => api.openAccountFolder(a.name))}>Open folder</button>
                  <button className="small" onClick={() => void props.run(() => api.removeAccount(a.name))}>Remove</button>
                </td>
              </tr>
              <tr>
                <td colSpan={4}>
                  <details>
                    <summary className="muted">Sign in, or change how it is signed in</summary>
                    {a.loginCommand && <>
                      <p className="muted">With Claude Code's own <span className="mono">/login</span>: run this in a terminal on this computer, then type <span className="mono">/login</span>.</p>
                      <CommandLine text={a.loginCommand} />
                    </>}
                    {a.tokenCommand && <TokenCommand command={a.tokenCommand} />}
                    <p className="muted">Either one replaces the sign-in that is there. For a project in a container, sign in inside the container with <span className="mono">/login</span>.</p>
                  </details>
                </td>
              </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
        <p>
          <button className="small" onClick={() => void props.run(() => api.checkSignIn())}>Check again</button>
          {' '}<span className="muted">after signing in from a terminal, to see it here</span>
        </p>

        <div className="form">
          <label>Account for chats <span className="muted">(New chat starts on it unless you choose another there; a chat keeps its account when resumed)</span>
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
            inside the container), or put in a long-lived token with the command shown. Ledung never sees or keeps a sign-in token.
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
            {' '}Now sign in once. With Claude Code's own <span className="mono">/login</span>: run this in a terminal on this computer, then type <span className="mono">/login</span> and sign in with this account.
            {added.loginCommand && <CommandLine text={added.loginCommand} />}
            For a container project, the same inside the container:
            <pre className="mono">{`docker exec -it <container> sh -c 'CLAUDE_SECURESTORAGE_CONFIG_DIR=${(added.containerDir ?? `~/.ledung-accounts/${added.name}`).replace(/^~\//, '$HOME/')} exec claude'`}</pre>
            {added.tokenCommand && <TokenCommand command={added.tokenCommand} />}
          </div>
        )}
      </div>
    </section>
  );
}
