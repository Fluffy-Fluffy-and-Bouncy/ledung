// Settings → Linked computers (issue #245, docs/steps/manager-link.md step 1): link this Ledung with another of
// your computers' Ledungs, once, with a code made on one and pasted on the other; unlink on either. Only on this
// computer: through the public name the list is refused, and the section stays away.
import { useEffect, useState } from 'react';
import { api, type LinkedComputerInfo } from '../api.ts';
import { usePlainTyping } from '../usePlainTyping.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;
type View = { publicName: string | null; problem: string | null; links: LinkedComputerInfo[] };

const when = (at: number | null) => (at ? new Date(at).toLocaleString() : 'never');

export function LinkedSettings({ run }: { run: Run }) {
  const typing = usePlainTyping();
  const [view, setView] = useState<View | null>(null);
  // The open code, and how many links there were when it was made: one more means it was used (it works once).
  const [open, setOpen] = useState<{ code: string; expiresAt: number; before: number } | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [now, setNow] = useState(Date.now());
  const load = () => api.links().then((v) => {
    setView(v);
    setOpen((o) => (o && v.links.length > o.before ? null : o));
  }, () => setView(null));
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
            <div key={l.id} className="device-row">
              <span><b>{l.name}</b> <span className="muted">· {l.publicName} · linked {when(l.linkedAt)} · last heard from {when(l.lastUsedAt)}</span></span>
              <button className="small" onClick={() => void run(async () => { await api.unlink(l.id); await load(); })}>Unlink</button>
            </div>
          ))}
          {live ? (
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
          <div className="link-join">
            <p className="muted">Or link with a code made on the other computer:</p>
            <input type="text" {...typing} value={code} placeholder="name.example.com/…" aria-label="Link code from the other computer" onChange={(e) => setCode(e.target.value)} />
            <input type="text" {...typing} value={name} maxLength={40} placeholder="Its name here, e.g. PC" aria-label="Name for the other computer" onChange={(e) => setName(e.target.value)} />
            <button disabled={!code.trim()} onClick={() => void run(async () => {
              await api.joinLink(code.trim(), name.trim());
              setCode('');
              setName('');
              await load();
            })}>Link</button>
          </div>
        </>
      )}
    </section>
  );
}
