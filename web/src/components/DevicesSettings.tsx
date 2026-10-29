// Settings → Phones, once Devices (issue #160, docs/steps/relay.md steps 4 and 5). On this computer: pair a phone with a
// one-time link and QR code (10 minutes, used once) and revoke paired devices. Through the public name: this
// device only, and setting up its passkey in the minutes after pairing; devices are managed on the computer.
import { useEffect, useState } from 'react';
import { api, type DeviceInfo } from '../api.ts';
import { pairQrText, qrModules } from './qr.ts';
import { browserPushSupport, pushIsOn, pushOff, pushOn } from '../push.ts';
import { inFrame } from '../computerFrame.ts';

const when = (at: number | null) => (at ? new Date(at).toLocaleString() : 'never');

/**
 * A QR code drawn as SVG squares (no markup from the library, so nothing to trust), with Ledung's own icon on
 * a clear square in its middle (#194).
 */
export function QrCode({ text }: { text: string }) {
  const { n, dark, logo } = qrModules(text);
  const cells: string[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) cells.push(`M${c + 4},${r + 4}h1v1h-1z`);
  // Half a module of white round the icon keeps its dark edge apart from the modules next to it.
  const at = logo.from + 4 + 0.5, size = logo.size - 1;
  return (
    <svg className="qr" viewBox={`0 0 ${n + 8} ${n + 8}`} width={220} height={220} role="img" aria-label="QR code of the pairing link">
      <rect width={n + 8} height={n + 8} fill="#fff" />
      <path d={cells.join('')} fill="#000" />
      <image href="/icon.svg?v=2" x={at} y={at} width={size} height={size} />
    </svg>
  );
}

export function DevicesSettings({ run }: { run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [here, setHere] = useState<Awaited<ReturnType<typeof api.thisDevice>> | null>(null);
  useEffect(() => {
    api.thisDevice().then(setHere, () => setHere({ remote: false }));
  }, []);
  if (!here) return null;
  return (
    <section>
      <h3>Phones</h3>
      {here.remote ? (
        <ThisDevice device={here.device} mayAddPasskey={here.mayAddPasskey} unlockedUntil={here.unlockedUntil} run={run} onChange={() => api.thisDevice().then(setHere)} />
      ) : <PairedDevices run={run} />}
    </section>
  );
}

function ThisDevice(props: {
  device: DeviceInfo; mayAddPasskey: boolean; unlockedUntil: number | null;
  run: (action: () => Promise<unknown>) => Promise<void>; onChange: () => void;
}) {
  const { device, unlockedUntil } = props;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const unlocked = unlockedUntil !== null && unlockedUntil > now;
  const computer = device.kind === 'computer';
  return (
    <>
      <p className="muted">This device is paired as <b>{device.name}</b>{computer ? ', a computer' : ''}. Devices are listed and removed in Settings on the computer Ledung runs on.</p>
      {device.passkey && computer ? (
        // A computer (issue #241, decision 6 on #245): logged on until it logs out, a sensitive call signed each time.
        <>
          <p className="muted">Its passkey is set up: allowing a sensitive call from here asks for it (Touch ID or Windows Hello) each time.</p>
          <p>
            {unlocked
              ? <>🔓 Logged on: changes need nothing more until you log out, or until 14 days without use.</>
              : <>🔒 Logged off: from here you can look, not change anything. Log on with the passkey; it lasts until you log out.</>}
          </p>
          {unlocked
            ? <button onClick={() => void props.run(async () => { await api.logOutDevice(); props.onChange(); })}>Log out</button>
            : <button onClick={() => void props.run(async () => { await api.unlockDevice(); props.onChange(); })}>Log on</button>}
        </>
      ) : device.passkey ? (
        <>
          <p className="muted">Its passkey is set up: allowing a sensitive call or writing to a manager from here asks for it (Face ID or fingerprint) each time.</p>
          <p>
            {unlocked
              ? <>🔓 Unlocked for changes until {new Date(unlockedUntil!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</>
              : <>🔒 Locked: from here you can look, not change anything. Unlocking takes the passkey once and lasts 30 minutes.</>}
          </p>
          {!unlocked && <button onClick={() => void props.run(async () => { await api.unlockDevice(); props.onChange(); })}>Unlock</button>}
          <PushSwitch run={props.run} onChange={props.onChange} />
        </>
      ) : props.mayAddPasskey && inFrame() ? (
        <EnrolInWindow run={props.run} onChange={props.onChange} />
      ) : props.mayAddPasskey ? (
        <>
          <p className="muted">Set up a passkey now: without it this device can only look, and every change waits for the computer. This is possible in the first 10 minutes after pairing.</p>
          <button onClick={() => void props.run(async () => { await api.addPasskey(); props.onChange(); })}>Set up passkey</button>
        </>
      ) : (
        <p className="muted">No passkey: this device can only look; changes wait for the computer. To add one, pair this device again from Settings on the computer.</p>
      )}
    </>
  );
}

/**
 * Setting up the passkey from inside a frame on another computer's page (issue #241): Safari can't create a passkey
 * in a frame on another site, only use one, so it is made on this Ledung's own page in a window of its own, from a
 * one-time link. The passkey lives in the system's keychain, so this frame can use it afterwards, also inside a web
 * app whose cookies are its own. Opened by a press on the link itself, so no popup blocker stops it; this page checks
 * every 2 seconds until the passkey is there.
 */
function EnrolInWindow({ run, onChange }: { run: (action: () => Promise<unknown>) => Promise<void>; onChange: () => void }) {
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(null);
  useEffect(() => {
    if (!link) return;
    const t = setInterval(() => {
      api.thisDevice().then((d) => {
        if (d.remote && d.device.passkey) onChange();
      }, () => {});
      if (Date.now() > link.expiresAt) setLink(null);
    }, 2000);
    return () => clearInterval(t);
  }, [link, onChange]);
  return (
    <>
      <p className="muted">Set up a passkey now: without it this device can only look. It is made in a window of its own (here inside another computer's page the browser may not make one), and works here afterwards. This is possible in the first 10 minutes after pairing.</p>
      {link
        ? <p><a className="button-link" href={link.url} target="_blank" rel="noopener noreferrer">Open the passkey window</a> <span className="muted">· then come back here</span></p>
        : <button onClick={() => void run(async () => setLink(await api.passkeyEnrolLink()))}>Set up passkey</button>}
    </>
  );
}

/**
 * Push notifications to this phone (issue #246): a notification for each new item in Waiting for you, even with
 * the page closed. It names the computer and the kind of item; the text loads when the page opens.
 */
function PushSwitch({ run, onChange }: { run: (action: () => Promise<unknown>) => Promise<void>; onChange: () => void }) {
  const support = browserPushSupport();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (support === 'yes') pushIsOn().then(setOn, () => setOn(false));
  }, [support]);
  if (support === 'home-screen') {
    return <p className="muted push-switch">Push notifications on an iPhone need Ledung on the Home Screen: Share → Add to Home Screen, then open it from there and switch them on here.</p>;
  }
  if (support === 'no') return <p className="muted push-switch">This browser can't get push notifications.</p>;
  if (on === null) return null;
  const set = (value: boolean) => void run(async () => {
    try {
      await (value ? pushOn() : pushOff());
      setOn(value);
    } finally {
      // Switching may have unlocked the device (one passkey check), which the lines above show.
      onChange();
    }
  });
  return (
    <div className="push-switch">
      <label className="toggle" title="A notification on this phone when something new waits for you, even with Ledung closed">
        <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Push notifications to this phone
      </label>
      <p className="muted">When something new waits for you on this computer. It says which computer and what kind of item, never the text: that loads when you open it.</p>
    </div>
  );
}

function PairedDevices({ run }: { run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [state, setState] = useState<{ publicName: string | null; devices: DeviceInfo[] } | null>(null);
  // The open code, and how many devices there were when it was made: one more means it was used (it works once).
  const [pairing, setPairing] = useState<{ url: string; expiresAt: number; kind: 'phone' | 'computer'; before: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const load = () => api.devices().then((s) => {
    setState(s);
    setPairing((p) => (p && s.devices.length > p.before ? null : p));
  }, () => {});
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!pairing) return;
    // The list refreshes while a code is open, so a phone that just paired shows up.
    const t = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 2000);
    return () => clearInterval(t);
  }, [pairing]);
  if (!state) return null;
  if (!state.publicName) {
    return <p className="muted">Reaching Ledung from a phone anywhere needs a relay: set "remote" with its "publicName" in the config. Then phones are paired here.</p>;
  }
  const open = pairing && pairing.expiresAt > now ? pairing : null;
  return (
    <>
      <p className="muted">Phones, and other computers' Ledung pages (their tab for this computer), that reach this Ledung at https://{state.publicName}. Only a paired device gets in there; the sign-in link does not work there. A phone unlocks for 30 minutes at a time; a computer stays logged on until it logs out.</p>
      {state.devices.length === 0 && <p className="muted">No paired devices.</p>}
      {state.devices.map((d) => (
        <div key={d.id} className="device-row">
          <span><b>{d.name}</b> <span className="muted">· {d.kind === 'computer' ? 'computer' : 'phone'} · paired {d.pairedVia ? `through the link from ${d.pairedVia} ` : ''}{when(d.createdAt)} · last used {when(d.lastUsedAt)} · {d.passkey ? `passkey added ${when(d.passkeyAt)}` : 'no passkey'}</span></span>
          <button className="small" onClick={() => void run(async () => { await api.revokeDevice(d.id); await load(); })}>Revoke</button>
        </div>
      ))}
      {open ? (
        <div className="pairing">
          {open.kind === 'phone' && <QrCode text={pairQrText(open.url)} />}
          {open.kind === 'computer'
            ? <p className="muted">On the other computer, click this computer's tab and type the code, or the link, into the field there. It works once, for {Math.max(0, Math.ceil((open.expiresAt - now) / 60000))} more minute(s). Then set up the passkey there and log on: it stays logged on until you log out.</p>
            : <p className="muted">Scan it with the phone, or open this link on it. It works once, for {Math.max(0, Math.ceil((open.expiresAt - now) / 60000))} more minute(s). Then set up the passkey on the phone, in its Settings → Remote & devices → Phones.</p>}
          {open.kind === 'computer' && <p className="pair-code"><b>{new URL(open.url).pathname.split('/').pop()!.toUpperCase()}</b></p>}
          <code className="pair-link">{open.url}</code>
        </div>
      ) : (
        <p className="device-pair-buttons">
          {(['phone', 'computer'] as const).map((kind) => (
            <button key={kind} onClick={() => void run(async () => {
              const made = await api.pairDevice(kind);
              // The countdown starts from now, not from when Settings was opened.
              setNow(Date.now());
              setPairing({ ...made, before: state.devices.length });
            })}>{kind === 'phone' ? 'Pair a phone' : 'Pair a computer'}</button>
          ))}
        </p>
      )}
    </>
  );
}
