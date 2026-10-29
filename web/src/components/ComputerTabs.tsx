// The computer tabs at the top of the page and the remote frame's label (issue #232, mockup variant A). Another
// computer's tab shows that computer's own Ledung page here, in a frame (issue #241, ComputerFrames): at its own
// origin, with its own sign-in and passkey; nothing of this page goes into it (docs/steps/computer-tabs-in-page.md).
// It is still a link to a new browser tab (issue #240), so a middle click, or Ctrl/Cmd-click, opens it there; noopener
// and noreferrer leave that page no handle back.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { ComputerInfo } from '../../../src/shared/computers.ts';
import { computerStyle, FRAME_ANSWER_MS, frameAsk, framePaired, pairsThroughLink, showsHere, tabWaiting, type ComputerFrame, type FramePairing } from '../computerFrame.ts';

const globe = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" />
    <path d="M1.5 8h13M8 1.5c2 2 2.6 4 2.6 6.5S10 12.5 8 14.5M8 1.5C6 3.5 5.4 5.5 5.4 8S6 12.5 8 14.5" />
  </svg>
);

/**
 * "Remote · <computer>", just "Remote" on a narrow screen (the stylesheet hides .long). A no-break space before the
 * dot: the label is a flex box, which drops a plain space at the start of the span.
 */
function remoteLabel(name: string | undefined): ReactNode {
  return <>{globe}Remote{name && <span className="long">{' '}· {name}</span>}</>;
}

/**
 * The strip, or with one computer in remote mode the band along the frame's top edge; nothing otherwise.
 * `shown`: the id of the other computer whose page shows here, null for this one's; `onShow` switches.
 * `waiting`: what Waiting for you counts on this computer, for its own tab's badge (issue #291).
 */
export function ComputerTabs({ frame, shown = null, onShow, waiting: hereWaiting = 0 }: {
  frame: ComputerFrame; shown?: string | null; onShow?: (name: string | null) => void; waiting?: number;
}) {
  const { tabs, remote, here } = frame;
  if (!tabs) {
    if (!remote) return null;
    return <div className="remote-band" role="status">{remoteLabel(here?.name)}</div>;
  }
  return (
    <nav className="ctabs" aria-label="Computers">
      {tabs.map((c) => {
        // What waits for you there (issue #273), as that computer told over the link: hidden at 0 or offline. This
        // computer's own tab shows what waits here while another computer's page shows (issue #291).
        const count = tabWaiting(c, shown, hereWaiting);
        const waiting = count ? <span className="badge" title={`${count} waiting for you on ${c.name}`} aria-label={`${count} waiting for you`}>{count}</span> : null;
        const body = <><span className="sw" aria-hidden="true" /><span className="nm">{c.name}</span>{waiting}</>;
        const on = c.here ? shown === null : shown === c.id;
        // This computer is not a link: it is the page you are on. While another one shows, it switches back.
        if (c.here) {
          if (on || !onShow) return <span key={c.id} className="ctab on" style={computerStyle(c)} aria-current="page">{body}</span>;
          return <button key={c.id} type="button" className="ctab" style={computerStyle(c)} onClick={() => onShow(null)}>{body}</button>;
        }
        if (!c.url) return null;
        return (
          <a key={c.id} className={`ctab${on ? ' on' : ''}`} style={computerStyle(c)} href={c.url} target="_blank" rel="noopener noreferrer" title={`${c.name}'s Ledung, ${new URL(c.url).host}`}
            aria-current={on ? 'page' : undefined}
            onClick={(e) => {
              if (!onShow || !showsHere(e)) return;
              e.preventDefault();
              onShow(c.id);
            }}>{body}</a>
        );
      })}
      <span className="spacer" />
      {remote && <span className="remote-tag" role="status">{remoteLabel(here?.name)}</span>}
    </nav>
  );
}

/**
 * The other computers' pages, each in a frame of its own (issue #241): made on its tab's first click and then kept,
 * so switching back and forth is instant and each keeps its live connection. A frame may use its own passkey
 * (publickey-credentials-*), and nothing else this page could grant. Its computer's colour goes round it.
 */
export function ComputerFrames({ computers, opened, shown, throughPublicName = false, framed: inAFrame = false }: {
  computers: ComputerInfo[]; opened: string[]; shown: string | null; throughPublicName?: boolean; framed?: boolean;
}) {
  // A frame pointed at a pairing link through the link (issue #273), by computer id; otherwise its page.
  const [pairing, setPairing] = useState<Record<string, string>>({});
  // Whether each frame's page is paired (issue #286): asked on each load, so Pair through the link shows only when not.
  const [paired, setPaired] = useState<Record<string, FramePairing>>({});
  const frames = useRef<Record<string, HTMLIFrameElement | null>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const framed = computers.filter((c) => !c.here && c.url && opened.includes(c.id));
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      for (const c of framed) {
        if (!framePaired({ data: e.data, origin: e.origin, fromFrame: e.source === frames.current[c.id]?.contentWindow }, c.url!)) continue;
        clearTimeout(timers.current[c.id]);
        setPaired((p) => ({ ...p, [c.id]: 'paired' }));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);
  const loaded = (c: ComputerInfo) => {
    clearTimeout(timers.current[c.id]);
    setPaired((p) => ({ ...p, [c.id]: 'unknown' }));
    frames.current[c.id]?.contentWindow?.postMessage(frameAsk(), new URL(c.url!).origin);
    timers.current[c.id] = setTimeout(() => setPaired((p) => ({ ...p, [c.id]: 'not-paired' })), FRAME_ANSWER_MS);
  };
  if (!framed.length) return null;
  return (
    <>
      {framed.map((c) => (
        <div key={c.id} className="cframe-box" hidden={shown !== c.id}>
          {pairsThroughLink(c, throughPublicName, inAFrame, paired[c.id] ?? 'unknown') && !pairing[c.id] && (
            <PairThroughLink computer={c} onCode={(url) => setPairing((p) => ({ ...p, [c.id]: url }))} />
          )}
          {pairing[c.id]
            ? <iframe key="pairing" className="cframe" style={computerStyle(c)} src={pairing[c.id]}
              title={`${c.name}'s Ledung`} allow="publickey-credentials-get; publickey-credentials-create" />
            : <iframe key="page" className="cframe" style={computerStyle(c)} src={c.url!}
              title={`${c.name}'s Ledung`} allow="publickey-credentials-get; publickey-credentials-create"
              ref={(el) => { frames.current[c.id] = el; }} onLoad={() => loaded(c)} />}
        </div>
      ))}
    </>
  );
}

/**
 * Pair through the link (issue #273; Martin's manager's decision on question #222, a): on this computer's own page,
 * above a linked computer's frame. Confirmed here, then that computer makes a pairing code for a computer and the
 * frame opens its pairing form, so this browser's frame pairs with no code to carry over. The new device is read-only
 * until it sets up its passkey and logs on there with Touch ID or Windows Hello; that computer shows the pairing.
 */
function PairThroughLink({ computer, onCode }: { computer: ComputerInfo; onCode: (url: string) => void }) {
  const [step, setStep] = useState<'offer' | 'confirm' | 'busy'>('offer');
  const [problem, setProblem] = useState<string | null>(null);
  const pair = () => {
    setStep('busy');
    setProblem(null);
    api.linkDevicePair(computer.id).then(({ url }) => onCode(url), (e: Error) => {
      setProblem(e.message);
      setStep('offer');
    });
  };
  return (
    <div className="cframe-bar" style={computerStyle(computer)} role={step === 'offer' ? undefined : 'alertdialog'} aria-label={`Pair through the link with ${computer.name}`}>
      {step === 'offer' ? (
        <>
          <span>Not paired with {computer.name} in this tab? It is linked with this computer.</span>
          <button type="button" className="small" onClick={() => setStep('confirm')}>Pair through the link</button>
        </>
      ) : (
        <>
          <span>Pair this browser with <b>{computer.name}</b> through the link? It can then look at {computer.name}'s sessions, and change nothing until it sets up its passkey and logs on there with Touch ID or Windows Hello. {computer.name} shows the pairing.</span>
          <button type="button" className="small" disabled={step === 'busy'} onClick={pair}>{step === 'busy' ? 'Pairing…' : 'Pair'}</button>
          <button type="button" className="small" disabled={step === 'busy'} onClick={() => setStep('offer')}>Cancel</button>
        </>
      )}
      {problem && <span className="restart-problem">{problem}</span>}
    </div>
  );
}
