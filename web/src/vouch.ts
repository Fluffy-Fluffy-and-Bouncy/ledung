// A trusted computer's screen stands in for the passkey (issue #313, docs/steps/trusted-computer.md choice 3a; Martin,
// 2026-11-13, question #890). The frame of another computer, given a challenge to be vouched for instead of a passkey
// prompt, hands it to the page that frames it; that page, this computer's own screen, asks its own Ledung to vouch for
// it over the link, and answers. Only between a frame and the page around it: the challenge alone allows nothing, and
// the other computer counts the vouch only from the computer it trusts, for that computer's own frame.

const ASK = 'ledung:vouch?';
const ANSWER = 'ledung:vouch';
/** How long the frame waits for the page around it; a vouch is one call over the link. */
export const VOUCH_WAIT_MS = 30_000;
const CHALLENGE = /^[A-Za-z0-9_-]{1,100}$/;
const ID = /^[0-9a-z]{1,40}$/;

export type VouchMessage =
  | { type: typeof ASK; id: string; challenge: string }
  | { type: typeof ANSWER; id: string; error: string | null };

const record = (data: unknown): Record<string, unknown> | null =>
  typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : null;

// The framing page's side.

/**
 * A frame asking this page to vouch: only from that computer's frame window, at its origin, and only for a computer
 * that trusts this one's screen (its tab shows the key). Returns what to vouch for, or null.
 */
export function vouchAsked(
  msg: { data: unknown; origin: string; fromFrame: boolean }, computer: { url: string; trustsUs?: boolean },
): { id: string; challenge: string } | null {
  let origin: string;
  try { origin = new URL(computer.url).origin; } catch { return null; }
  if (!msg.fromFrame || msg.origin !== origin || !computer.trustsUs) return null;
  const d = record(msg.data);
  if (d?.type !== ASK || typeof d.id !== 'string' || !ID.test(d.id) || typeof d.challenge !== 'string' || !CHALLENGE.test(d.challenge)) return null;
  return { id: d.id, challenge: d.challenge };
}

/** The answer to a frame's ask: null when vouched for, otherwise why not. */
export function vouchAnswer(id: string, error: string | null): VouchMessage {
  return { type: ANSWER, id, error };
}

// The framed page's side.

/** The ask the framed page sends the page around it. */
export function vouchAsk(id: string, challenge: string): VouchMessage {
  return { type: ASK, id, challenge };
}

/** The answer to ask `id`, only from the page that frames this one: undefined when it is not; null when vouched for. */
export function vouchAnswered(data: unknown, fromParent: boolean, id: string): string | null | undefined {
  const d = record(data);
  if (!fromParent || d?.type !== ANSWER || d.id !== id) return undefined;
  return typeof d.error === 'string' ? d.error : null;
}

/**
 * In the browser: asks the page around this frame to vouch for `challenge`, and resolves once it has, or rejects with
 * its reason, or when it doesn't answer. The ask goes to any origin: only the pages frame-ancestors allows can frame
 * this one, the challenge allows nothing by itself, and only window.parent's answer counts.
 */
export function vouchByFramingPage(challenge: string): Promise<void> {
  const id = Math.random().toString(36).slice(2, 12) || 'v';
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (e: MessageEvent) => {
      const error = vouchAnswered(e.data, e.source === window.parent, id);
      if (error === undefined) return;
      done();
      if (error === null) resolve();
      else reject(new Error(error));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('The trusted computer\'s screen did not answer; is its page still open?'));
    }, VOUCH_WAIT_MS);
    window.addEventListener('message', onMessage);
    window.parent.postMessage(vouchAsk(id, challenge), '*');
  });
}
