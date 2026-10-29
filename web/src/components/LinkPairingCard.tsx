// A pairing a linked computer asked for (issue #273, docs/steps/computer-tabs-link.md part 2), in Waiting for you on
// the computer that was paired with: a browser on the other computer's own screen can now look at this one's sessions,
// so it is never unseen here. It changes nothing until its passkey is set up and it logs on with Touch ID or Windows
// Hello here (#244); Remove device takes it away at once.
import { useState } from 'react';
import type { LinkPairingInfo } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;

export function LinkPairingCard({ pairing, run }: { pairing: LinkPairingInfo; run: Run }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    void run(() => action().catch((e) => setProblem((e as Error).message))).finally(() => setBusy(false));
  };
  const at = new Date(pairing.at).toLocaleString();
  const { device } = pairing;
  return (
    <div className="new-computer">
      <div className="new-computer-head">{device ? <>{pairing.computer} paired <code>{device.name}</code> through the link</> : <>{pairing.computer} opened a pairing through the link</>}</div>
      <p className="muted">
        {device
          ? `At ${at}, from ${pairing.computer}'s own screen. It can look at this computer's sessions, questions and chats; it can change nothing until it sets up its passkey and logs on here with Touch ID or Windows Hello.`
          : `At ${at}, from ${pairing.computer}'s own screen: a pairing code for a browser there, good for 10 minutes. Nothing has paired with it yet.`}
      </p>
      <div className="restart-confirm">
        {device && <button className="small" disabled={busy} onClick={() => act(async () => {
          await api.revokeDevice(device.id);
          await api.dismissLinkPairing(pairing.id);
        })}>Remove device</button>}
        <button className="small" disabled={busy} onClick={() => act(() => api.dismissLinkPairing(pairing.id))} title="Takes this card away; the device stays in Settings → Phones">OK</button>
      </div>
      {problem && <p className="restart-problem">{problem}</p>}
    </div>
  );
}
