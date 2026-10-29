// Invite a computer and Join with a code (issue #237). Settings → Remote: Join with a code, or Leave this relay, on
// the computer joining. Settings → Relay: the relay admin's own settings (relay address, admin key, Cloudflare token)
// and Invite a computer. The admin key and the token are typed or made here but never come back to the page: it
// sees the key's SHA-256 and whether a token is set.
import { useEffect, useState } from 'react';
import type { NewComputerInfo, RelayAdminView, RelayInviteInfo, RemoteStatus } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { CopyButton } from './Markdown.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;

/** Under Settings → Remote: Join with a code when on no relay, Leave this relay when joined here. */
export function JoinRelay({ remote }: { remote: RemoteStatus | null }) {
  const [link, setLink] = useState<Awaited<ReturnType<typeof api.remoteLink>> | null>(null);
  const [code, setCode] = useState('');
  const typing = usePlainTyping();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const refresh = () => void api.remoteLink().then(setLink, () => setLink(null));
  // Again whenever the public name changes, so Join and Leave follow another tab's action too.
  useEffect(refresh, [remote?.publicName]);
  if (!link) return null;
  if (link.source === 'config') {
    return <p className="muted">This relay is set in the config file (<code>"remote"</code>); change or remove it there.</p>;
  }
  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    action().then(() => {
      setCode('');
      setLeaving(false);
      refresh();
    }, (e) => setProblem((e as Error).message)).finally(() => setBusy(false));
  };
  if (link.source === 'joined') {
    const cert = remote?.certificate;
    const ready = remote?.state === 'connected' && cert?.state === 'valid';
    return (
      <div className="relay-join">
        {ready && <p className="remote-state connected">Connected, certificate ok. Pair your phone in Phones below.</p>}
        {!ready && cert?.state === 'waiting-caa' && <p className="muted">The relay's admin approves this computer, which adds the CAA record; the certificate follows within a minute.</p>}
        {leaving ? (
          <div className="restart-confirm">
            <span>Leave the relay? Phones stop reaching this Ledung at once; joining again needs a new code.</span>
            <button className="small danger" disabled={busy} onClick={() => act(api.remoteLeave)}>Leave</button>
            <button className="small" disabled={busy} onClick={() => setLeaving(false)}>Cancel</button>
          </div>
        ) : <button className="small" onClick={() => setLeaving(true)}>Leave this relay</button>}
        {problem && <p className="restart-problem">{problem}</p>}
      </div>
    );
  }
  return (
    <div className="relay-join">
      <p className="muted">Got a join code from a relay's admin? Paste it here: Ledung makes its own secret and certificate account, joins the relay and connects, with no restart.</p>
      <div className="relay-row">
        <input {...typing} value={code} onChange={(e) => setCode(e.target.value)} placeholder="relay.example.org/ABCD-…" spellCheck={false} autoComplete="off" aria-label="Join code" />
        <button disabled={busy || !code.trim()} onClick={() => act(() => api.remoteJoin(code))}>{busy ? 'Joining…' : 'Join with a code'}</button>
      </div>
      {problem && <p className="restart-problem">{problem}</p>}
    </div>
  );
}

/**
 * Settings → Relay: for whoever runs a relay. Until a relay or an admin key is set it is one line in Remote & devices,
 * whose Set up opens this (issue #365), since most people don't run one; the caller reads the admin view.
 */
export function RelayAdminSettings({ view, onView, run, newComputers }: { view: RelayAdminView; onView: (v: RelayAdminView) => void; run: Run; newComputers: NewComputerInfo[] }) {
  return (
    <>
      <RelayAdminForm view={view} onView={onView} run={run} />
      {view.relay && view.keySha256 && <Invites run={run} newComputers={newComputers} tokenSet={view.tokenSet} />}
    </>
  );
}

/** A relay address or an admin key is set: the relay admin has set up (#237). */
export const relaySetUp = (view: RelayAdminView): boolean => !!view.relay || !!view.keySha256;

function RelayAdminForm({ view, onView, run }: { view: RelayAdminView; onView: (v: RelayAdminView) => void; run: Run }) {
  const [relay, setRelay] = useState(view.relay ?? '');
  const typing = usePlainTyping();
  const [token, setToken] = useState('');
  return (
    <div className="relay-admin">
      <div className="relay-row">
        <label>Relay <input {...typing} value={relay} onChange={(e) => setRelay(e.target.value)} placeholder="wss://relay.example.org" spellCheck={false} /></label>
        <button className="small" disabled={relay.trim() === (view.relay ?? '')} onClick={() => void run(async () => onView(await api.setRelayAdmin({ relay })))}>Save</button>
      </div>
      <p className="muted">
        Admin key: {view.keySha256
          ? <>made. Its SHA-256 goes in the relay's config as <code>"adminKeySha256"</code>: <code className="remote-record">{view.keySha256}</code> <CopyButton text={view.keySha256} /></>
          : 'none yet. Ledung makes it and keeps it in its data folder; only its SHA-256 goes to the relay.'}
      </p>
      <button className="small" onClick={() => void run(async () => onView(await api.makeRelayAdminKey()))}>{view.keySha256 ? 'Make a new admin key' : 'Make admin key'}</button>
      <p className="muted">
        Cloudflare token (Zone DNS edit, for the relay's domain): {view.tokenSet ? 'set. Approve writes new computers\' CAA records with it.' : 'none. Without one, copy each new computer\'s CAA record into the DNS yourself.'} It stays on this computer and is never shown again.
      </p>
      <div className="relay-row">
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={view.tokenSet ? 'Replace the token' : 'Paste the token'} autoComplete="off" aria-label="Cloudflare token" />
        <button className="small" disabled={!token.trim()} onClick={() => void run(async () => { onView(await api.setRelayAdmin({ cloudflareToken: token })); setToken(''); })}>Save token</button>
        {view.tokenSet && <button className="small" onClick={() => void run(async () => onView(await api.setRelayAdmin({ cloudflareToken: '' })))}>Remove token</button>}
      </div>
    </div>
  );
}

function Invites({ run, newComputers, tokenSet }: { run: Run; newComputers: NewComputerInfo[]; tokenSet: boolean }) {
  const [owner, setOwner] = useState('');
  const typing = usePlainTyping();
  const [name, setName] = useState('');
  const [made, setMade] = useState<(RelayInviteInfo & { code: string }) | null>(null);
  const [invites, setInvites] = useState<RelayInviteInfo[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const refresh = () => void api.relayComputers().then((r) => { setInvites(r.invites); setProblem(null); }, (e) => setProblem((e as Error).message));
  useEffect(refresh, []);
  return (
    <div className="relay-invites">
      <h4>Invite a computer</h4>
      <div className="relay-row">
        <input {...typing} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Whose computer" aria-label="Owner" />
        <input {...typing} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional: two words and digits otherwise)" spellCheck={false} aria-label="Name" />
        <button disabled={!owner.trim()} onClick={() => void run(async () => { setMade(await api.relayInvite(owner, name.trim() || undefined)); setOwner(''); setName(''); refresh(); })}>Invite</button>
      </div>
      {made && (
        <div className="relay-code">
          <p>Join code for {made.owner}'s computer, <b>{made.host}</b>. It is shown only now, works once, and runs out at {new Date(made.expiresAt).toLocaleString()}:</p>
          <p><code className="remote-record">{made.code}</code> <CopyButton text={made.code} /></p>
          <p className="muted">They paste it in their Ledung under Settings → Remote access → Join with a code. Then the computer shows up in Waiting for you{tokenSet ? ' to approve' : ' with its CAA record to add'}.</p>
        </div>
      )}
      {problem && <p className="restart-problem">{problem}</p>}
      {invites && invites.length > 0 && (
        <>
          <h4>Not used yet</h4>
          <ul className="relay-list">
            {invites.map((i) => (
              <li key={i.id}>{i.host} for {i.owner}, until {new Date(i.expiresAt).toLocaleString()}{' '}
                <button className="small" onClick={() => void run(async () => { await api.revokeRelayInvite(i.id); refresh(); })}>Revoke</button></li>
            ))}
          </ul>
        </>
      )}
      {newComputers.length > 0 && <p className="muted">{newComputers.length} computer{newComputers.length === 1 ? '' : 's'} joined and wait{newComputers.length === 1 ? 's' : ''} for the CAA record: see Waiting for you.</p>}
    </div>
  );
}

/** The Approve card in Waiting for you: a computer that joined and waits for its CAA record. */
export function NewComputerCard({ computer, run }: { computer: NewComputerInfo; run: Run }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    void run(() => action().catch((e) => setProblem((e as Error).message))).finally(() => setBusy(false));
  };
  const approve = () => act(() => api.approveComputer(computer.name));
  return (
    <div className="new-computer">
      <div className="new-computer-head">New computer <code>{computer.name}</code> for {computer.owner}</div>
      <p className="muted">It joined the relay as {computer.host}{computer.enrolledAt ? ` at ${new Date(computer.enrolledAt).toLocaleString()}` : ''}. Its certificate needs this CAA record, which names its own ACME account:</p>
      <p><code className="remote-record">{computer.record}</code></p>
      <div className="restart-confirm">
        {computer.approvable && <button className="small" disabled={busy} onClick={approve} title="Writes the record through Cloudflare with the token in Settings → Relay; never changes an existing one">{busy ? 'Approving…' : 'Approve'}</button>}
        <CopyButton text={computer.record} />
        {!computer.approvable && <button className="small" disabled={busy} onClick={() => act(() => api.computerAdded(computer.name))}>I added it</button>}
      </div>
      {!computer.approvable && <p className="muted">No Cloudflare token is set in Settings → Relay: copy the record into the DNS yourself, then press I added it.</p>}
      {problem && <p className="restart-problem">{problem}</p>}
    </div>
  );
}
