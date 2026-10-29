// Publish usage in Settings → Claude & usage (issue #363): one line with Set up while it is off, as the Settings frame
// shows a feature that is off (#365); then the switch, the repo from the board's picker, how publishing went, the
// usage key, and the computers publishing to the repo. Which accounts are published is chosen here, one by one or
// all of them (#380); a project's name and its own usage repo are ProjectUsagePublish, in the project's settings.
import { useCallback, useEffect, useState } from 'react';
import type { SharedUsageEntry, SharedUsageView, UsagePublishView } from '../../../src/shared/published-usage.ts';
import type { AccountInfoView } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { RepoPicker } from './BoardViews.tsx';
import { CopyButton } from './Markdown.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const loadRepos = (refresh: boolean) => api.usagePublishRepos(refresh);

function ago(at: number): string {
  const min = Math.round((Date.now() - at) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

export function UsagePublishSettings({ accounts: known, run }: { accounts: AccountInfoView[]; run: Run }) {
  const [view, setView] = useState<UsagePublishView | null>(null);
  const [shared, setShared] = useState<SharedUsageView | null>(null);
  const [repo, setRepo] = useState('');
  const [allAccounts, setAllAccounts] = useState(false);
  const [accounts, setAccounts] = useState<string[]>([]);
  // Off: one line with Set up, as the Settings frame shows a feature that is off (#365); Set up opens the form in place.
  const [opened, setOpened] = useState(false);
  const read = useCallback(() => {
    api.usagePublish().then((v) => setView(v), () => {});
    api.sharedUsage().then(setShared, () => {});
  }, []);
  useEffect(() => {
    read();
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, [read]);
  const savedAll = view?.allAccounts ?? false;
  const savedAccounts = (view?.accounts ?? []).join('\n');
  useEffect(() => {
    if (!view) return;
    setRepo(view.repo ?? '');
    setAllAccounts(savedAll);
    setAccounts(savedAccounts ? savedAccounts.split('\n') : []);
  }, [view?.repo, savedAll, savedAccounts]);
  if (!view) return null;
  const typed = repo.trim();
  const repoOk = !typed || REPO.test(typed);
  // On while any account is (#380): there is no switch above the accounts.
  const enabled = allAccounts || accounts.length > 0;
  const dirty = allAccounts !== savedAll || [...accounts].sort().join('\n') !== savedAccounts || typed !== (view.repo ?? '');
  const save = () => run(async () => {
    setView(await api.setUsagePublish(enabled, typed || null, { allAccounts, accounts: [...accounts].sort() }));
    setShared(await api.sharedUsage(true));
  });
  // The computer's own login, every account Ledung knows, and any still switched on that has since been removed.
  const names = [...new Set(['default', ...known.map((a) => a.name), ...view.accounts])];
  const emailOf = (name: string) => known.find((a) => a.name === name)?.email ?? null;
  const toggle = (name: string, on: boolean) => setAccounts((list) => (on ? [...new Set([...list, name])] : list.filter((a) => a !== name)));

  const off = !view.enabled && !view.pendingRemovals?.length;
  if (off && !opened) {
    return (
      <section>
        <h3>Not set up</h3>
        <div className="offline">
          <span className="offline-name">Publish usage</span>
          <span className="offline-why">Share this computer's usage totals with your other computers through a GitHub repository.</span>
          <button className="small" onClick={() => setOpened(true)}>Set up ›</button>
        </div>
      </section>
    );
  }
  const body = (
    <>
      <p className="muted">Shares this computer's usage totals with a GitHub repository, through your <span className="mono">gh</span> login, so the Shared tab can show every computer's usage side by side. Each computer keeps one file there and replaces it every 5 minutes when something changed.</p>
      <div role="group" aria-label="Accounts to publish">
        <h4>Accounts</h4>
        <label className="toggle">
          <input type="checkbox" checked={allAccounts} onChange={(e) => setAllAccounts(e.target.checked)} />
          {' '}<span><span className="field-name">All accounts</span> <span className="muted">(every Claude account on this computer, ones added later too)</span></span>
        </label>
        {names.map((name) => (
          <label key={name} className="toggle">
            <input type="checkbox" checked={allAccounts || accounts.includes(name)} disabled={allAccounts} onChange={(e) => toggle(name, e.target.checked)} />
            {' '}<span><span className="field-name">Publish {name}</span>{' '}
              <span className="muted">({name === 'default' ? "this computer's own login" : emailOf(name) ?? 'not signed in yet'}{!known.some((a) => a.name === name) && name !== 'default' ? ', removed' : ''})</span></span>
          </label>
        ))}
      </div>
      <RepoPicker project="" label="Default usage repository" newName="ledung-usage" value={repo} ok={repoOk} onChange={setRepo} load={loadRepos} />
      <p className="muted">
        Every project publishes here unless its own settings name a usage repository of its own.
        {!!view.projectRepos?.length && <> Projects with their own: {view.projectRepos.map((r, i) => <span key={r.repo}>{i ? '; ' : ''}{r.projects.join(', ')} → <span className="mono">{r.repo}</span></span>)}.</>}
      </p>
      {(enabled || typed) && (
        <div className="board-warning">
          <strong>Everyone with read access to {typed && repoOk ? typed : 'the repository'} sees what is published</strong>: this computer's name, your GitHub login, and for each account
          switched on above, per day and model, the tokens, API-equivalent cost and calls, and its plan limits; a project with a repository of its own goes there instead. A project shows by name only where you switch that on in its
          settings; every other project is <span className="mono">other#</span> and four characters. Never prompts, replies, tool output, paths,
          folder or branch names, session titles, emails or tokens.
        </div>
      )}
      <button disabled={!dirty || !repoOk || (enabled && !typed)} onClick={() => void save()}>Save</button>
      {enabled && !typed && <span className="muted"> Choose the repository to publish to.</span>}
      {!enabled && view.enabled && <span className="muted"> No account is switched on: saving stops publishing and removes this computer's usage from the repositories.</span>}
      {view.enabled && (
        <p className="muted">
          Publishes as <strong>{view.computer}</strong>{view.lastPublishedAt ? `; last published ${ago(view.lastPublishedAt)}` : ''}.
          {view.error && <span className="board-error"> The last publish failed: {view.error} Ledung tries again shortly (after 1, 2, then every 5 minutes).</span>}
        </p>
      )}
      {!!view.pendingRemovals?.length && (
        <p className="board-error">
          This computer's usage is still in {view.pendingRemovals.join(', ')}; Ledung keeps trying to remove it.{!view.enabled && view.error ? ` ${view.error}` : ''}
        </p>
      )}
      <UsageKey view={view} onView={setView} run={run} />
      {shared?.repo && <SharedComputers shared={shared} onShared={setShared} run={run} />}
    </>
  );
  if (off) {
    return (
      <section>
        <h3>Not set up</h3>
        <div className="offline-open" role="group" aria-label="Publish usage">
          <h4><span>Publish usage</span><button className="small" aria-label="Close Publish usage" title="Close" onClick={() => setOpened(false)}>✕</button></h4>
          {body}
        </div>
      </section>
    );
  }
  return <section><h3>Publish usage</h3>{body}</section>;
}

/**
 * The usage key labels projects not published by name; computers that share it label a project alike. Linked
 * computers share it by themselves when publishing is switched on; another computer can paste it here.
 */
function UsageKey({ view, onView, run }: { view: UsagePublishView; onView: (v: UsagePublishView) => void; run: Run }) {
  const typing = usePlainTyping();
  const [shown, setShown] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  return (
    <div>
      <h4>Usage key</h4>
      <p className="muted">
        Makes a project's <span className="mono">other#</span> label the same on all your computers, without its name. It stays on this computer,
        next to the link keys. {view.hasKey ? 'This computer has one.' : 'This computer makes one, or takes a linked computer\'s, when publishing is switched on.'}
      </p>
      <div className="board-add">
        {view.hasKey && !shown && <button className="small" onClick={() => void run(async () => setShown((await api.revealUsageKey()).key))}>Show the key</button>}
        {shown && <><span className="mono">{shown}</span> <CopyButton text={shown} /> <button className="small" onClick={() => setShown(null)}>Hide</button></>}
        <button className="small" onClick={() => void run(async () => onView(await api.takeLinkedUsageKey()))}>Take a linked computer's key</button>
      </div>
      <div className="board-add">
        <input {...typing} className="mono" value={paste} placeholder="Paste a usage key from another computer" onChange={(e) => setPaste(e.target.value.trim())} />
        <button className="small" disabled={!paste} onClick={() => void run(async () => { onView(await api.setUsageKey(paste)); setPaste(''); setShown(null); })}>Use this key</button>
      </div>
    </div>
  );
}

function SharedComputers({ shared, onShared, run }: { shared: SharedUsageView; onShared: (v: SharedUsageView) => void; run: Run }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <div>
      <h4>Computers publishing to {shared.repo}</h4>
      {shared.error && <p className="board-error">{shared.error}</p>}
      {!shared.entries.length && !shared.error && <p className="muted">None yet.</p>}
      <ul className="board-counts">
        {shared.entries.map((e) => (
          <li key={e.id}>
            <ComputerLine entry={e} />
            {e.stale && !e.own && shared.canRemove && (confirming === e.id
              ? <> <button className="small danger" onClick={() => void run(async () => { onShared(await api.removeSharedUsage(e.id)); setConfirming(null); })}>Confirm: remove its usage</button> <button className="small" onClick={() => setConfirming(null)}>Cancel</button></>
              : <> <button className="small" onClick={() => setConfirming(e.id)}>Remove…</button></>)}
          </li>
        ))}
      </ul>
      <button className="small" onClick={() => void run(async () => onShared(await api.sharedUsage(true)))}>Check again</button>
    </div>
  );
}

function ComputerLine({ entry: e }: { entry: SharedUsageEntry }) {
  const who = `${e.computer ?? 'A computer'}${e.login ? ` (@${e.login})` : ''}${e.own ? ', this computer' : ''}`;
  if (e.state === 'newer') return <span><strong>{who}</strong>: published by a newer Ledung. Update Ledung to read it.</span>;
  if (e.state === 'invalid') return <span><strong>{who}</strong>: its file can't be read ({e.reason}).</span>;
  return (
    <span>
      <strong>{who}</strong>{e.asOf ? `, as of ${ago(e.asOf)}` : ''}
      {e.stale && <span className="chip warn">silent for 30 days</span>}
    </span>
  );
}

/**
 * In a project's settings: its name in the published usage (#312, #316), and the usage repo it publishes to instead of
 * the computer's default one (#380), from the same picker as Settings.
 */
export function ProjectUsagePublish<T extends { publishUsageName: boolean; usageRepo: string }>({ value, onChange }: { value: T; onChange: (s: T) => void }) {
  const typed = value.usageRepo.trim();
  return (
    <>
      <PublishUsageName value={value.publishUsageName} onChange={(publishUsageName) => onChange({ ...value, publishUsageName })} />
      <RepoPicker project="" label={<span className="field-name">Usage repository</span>} newName="ledung-usage"
        value={value.usageRepo} ok={!typed || REPO.test(typed)} onChange={(usageRepo) => onChange({ ...value, usageRepo })} load={loadRepos} />
      <span className="muted">Where its usage is published, instead of this computer's default repository (Settings → Claude &amp; usage → Publish usage); empty: the default.</span>
    </>
  );
}

/** In a project's settings: publish this project's usage under its name, not as `other#` and a hash (#312, #316). */
function PublishUsageName({ value, onChange }: { value: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {' '}<span><span className="field-name">Publish its usage under its name</span> <span className="muted">(when usage is published in Settings; otherwise it shows as other# and four characters)</span></span>
    </label>
  );
}
