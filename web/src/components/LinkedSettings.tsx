// Settings → Linked computers (issue #245, docs/steps/manager-link.md step 1): link this Ledung with another of
// your computers' Ledungs, once, with a code made on one and pasted on the other; unlink on either. Only on this
// computer: through the public name the list is refused, and the section stays away; except on a phone, which sees
// the list to trust a computer's screen from there with its passkey, and nothing else (issue #313).
import { useEffect, useState } from 'react';
import { api, type LinkBytes, type LinkedComputerInfo } from '../api.ts';
import { usePlainTyping } from '../usePlainTyping.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;
type View = { publicName: string | null; problem: string | null; links: LinkedComputerInfo[]; here: boolean };

const when = (at: number | null) => (at ? new Date(at).toLocaleString() : 'never');

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);
/** Files sent and received through the link (issue #158), today and this month; counted only, nothing is held back on it. */
const filesLine = (f: LinkBytes) => `files sent ${size(f.today.sent)} today, ${size(f.month.sent)} this month · received ${size(f.today.received)} today, ${size(f.month.received)} this month`;

export function LinkedSettings({ run }: { run: Run }) {
  const typing = usePlainTyping();
  const [view, setView] = useState<View | null>(null);
  // The open code, and how many links there were when it was made: one more means it was used (it works once).
  const [open, setOpen] = useState<{ code: string; expiresAt: number; before: number } | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [now, setNow] = useState(Date.now());
  const load = () => api.links().then((v) => {
    setView({ ...v, here: true });
    setOpen((o) => (o && v.links.length > o.before ? null : o));
    // Not on this computer: a phone sees each link's trust only (issue #313); anything else, nothing.
  }, () => api.linkTrust().then(
    (t) => setView({ publicName: null, problem: null, links: t.links.map((l) => ({ ...l, publicName: '', linkedAt: 0, lastUsedAt: null })), here: false }),
    () => setView(null),
  ));
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!open) return;
    // The list refreshes while a code is open, so the other computer shows up once it has linked.
    const t = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 2000);
    return () => clearInterval(t);
  }, [open]);
  if (!view) return null;
  const live = open && open.expiresAt > now ? open : null;
  return (
    <section>
      <h3>Linked computers</h3>
      {view.problem ? <p className="muted">{view.problem}</p> : (
        <>
          <p className="muted">Your other computers' Ledungs this one is linked with. Their managers will reach this computer's managers as if they ran here; the link goes end to end through the relay, which can't read it.</p>
          {view.links.length === 0 && <p className="muted">No linked computers.</p>}
          {view.links.map((l) => (
            <div key={l.id}>
              <div className="device-row">
                <span><b>{l.name}</b>{l.trustedAt !== undefined && <span className="trust-tag">Trusted</span>}{view.here && <span className="muted"> · {l.publicName} · linked {when(l.linkedAt)} · last heard from {when(l.lastUsedAt)}{l.files ? ` · ${filesLine(l.files)}` : ''}</span>}</span>
                {view.here && <button className="small" onClick={() => void run(async () => { await api.unlink(l.id); await load(); })}>Unlink</button>}
              </div>
              <TrustRow link={l} run={run} onChange={load} />
            </div>
          ))}
          {(() => {
            const trustsUs = view.links.filter((l) => l.trustsUs).map((l) => l.name);
            return trustsUs.length > 0 && <p className="muted">This computer's screen is trusted by: <b>{trustsUs.join(', ')}</b>. Their tabs here act there with no passkey.</p>;
          })()}
          {!view.here ? null : live ? (
            <div className="pairing">
              <p className="muted">Paste this in Settings → Linked computers on the other computer. It works once, for {Math.max(0, Math.ceil((live.expiresAt - now) / 60000))} more minute(s).</p>
              <code className="pair-link">{live.code}</code>
              <button className="small" onClick={() => void navigator.clipboard?.writeText(live.code)}>Copy</button>
            </div>
          ) : (
            <button onClick={() => void run(async () => {
              const made = await api.linkCode();
              setNow(Date.now());
              setOpen({ ...made, before: view.links.length });
            })}>Link a computer</button>
          )}
          {view.here && <div className="link-join">
            <p className="muted">Or link with a code made on the other computer:</p>
            <input type="text" {...typing} value={code} placeholder="name.example.com/…" aria-label="Link code from the other computer" onChange={(e) => setCode(e.target.value)} />
            <input type="text" {...typing} value={name} maxLength={40} placeholder="Its name here, e.g. PC" aria-label="Name for the other computer" onChange={(e) => setName(e.target.value)} />
            <button disabled={!code.trim()} onClick={() => void run(async () => {
              await api.joinLink(code.trim(), name.trim());
              setCode('');
              setName('');
              await load();
            })}>Link</button>
          </div>}
        </>
      )}
    </section>
  );
}

/**
 * Trusting a linked computer's own screen (issue #313, docs/steps/trusted-computer.md; Martin, 2026-11-13, question
 * #890, a): its tab for this computer then logs on and acts here with no passkey, sensitive prompts included, but not
 * opening lockdown. Set with a confirm that says the cost; removed at once.
 */
function TrustRow({ link, run, onChange }: { link: LinkedComputerInfo; run: Run; onChange: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const set = (on: boolean) => void run(async () => {
    await api.trustLink(link.id, on);
    setAsking(false);
    await onChange();
  });
  if (link.trustedAt !== undefined) {
    return (
      <div className="trust-row">
        <p>🔓 <b>Its own screen acts here without a passkey</b> <span className="muted">· since {new Date(link.trustedAt).toLocaleDateString()}, set {link.trustedFrom === 'phone' ? 'from a phone' : 'on this computer'}</span></p>
        <p className="muted">From {link.name}'s tab for this computer: log on, send, allow prompts (sensitive ones too), <code>!</code> commands and away mode, with no Touch ID or Windows Hello. Opening lockdown still needs a passkey or this screen.</p>
        <button className="small" onClick={() => set(false)}>Remove trust</button>
      </div>
    );
  }
  return (
    <div className="trust-row">
      {!asking ? (
        <p><span className="muted">Its tab here asks for a passkey for changes.</span> <button className="small" onClick={() => setAsking(true)}>Trust its own screen…</button></p>
      ) : (
        <div className="new-computer" role="alertdialog" aria-label={`Trust ${link.name}'s own screen`}>
          <div className="new-computer-head">Trust {link.name}'s own screen?</div>
          <p>Anyone at {link.name} while it is unlocked, or anything running on it, could then act on this computer without a passkey — merges and sensitive prompts included — until you remove the trust here. The prompts still show; only the passkey step goes.</p>
          <div className="restart-confirm">
            <button className="small primary" onClick={() => set(true)}>Trust</button>
            <button className="small" onClick={() => setAsking(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
