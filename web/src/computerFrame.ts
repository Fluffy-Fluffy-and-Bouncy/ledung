// The computer tabs and the remote frame (issue #232, mockup variant A), kept apart from the component so it can be
// tested: which tabs show, which is this computer, and the colour the tab, frame and label take.

import type { CSSProperties } from 'react';
import { computerColour, type ComputerInfo } from '../../src/shared/computers.ts';

export interface ComputerFrame {
  /** The tabs, this computer first (#240); null with one computer or none (no strip). */
  tabs: ComputerInfo[] | null;
  /** The page came through the public name: a frame round the whole page in this computer's colour. */
  remote: boolean;
  /** This computer, for the frame's label "Remote · <name>". */
  here: ComputerInfo | null;
}

/**
 * `framed`: this page is shown in a frame on another computer's page (issue #241), which only those computers' pages
 * can do (frame-ancestors). That page draws the tabs and the frame round this one, so this one draws neither.
 */
export function computerFrame(computers: ComputerInfo[], throughPublicName: boolean, framed = false): ComputerFrame {
  if (framed) return { tabs: null, remote: false, here: computers.find((c) => c.here) ?? null };
  return {
    tabs: computers.length > 1 ? computers : null,
    remote: throughPublicName,
    here: computers.find((c) => c.here) ?? null,
  };
}

/**
 * What this page knows of a frame's pairing (issue #286): the frame's own page says it is paired when asked
 * (frameAnswer); the not-paired page is plain HTML with no script, so no answer within FRAME_ANSWER_MS means not paired.
 */
export type FramePairing = 'unknown' | 'paired' | 'not-paired';

/** How long a frame's page has to answer after it loaded before it counts as not paired. */
export const FRAME_ANSWER_MS = 3000;

const FRAME_ASK = 'ledung:paired?';
const FRAME_PAIRED = 'ledung:paired';

/**
 * Whether this page offers Pair through the link for a computer's frame (issue #273): only for a linked computer, and
 * only on this computer's own page. Through the public name the server refuses it anyway (a phone must never start
 * one), and in a frame this page shows no frames. Only while the frame is not paired (issue #286): offered over a
 * paired frame, "Not paired with Tubal Cain in this tab?" read as the pairing being lost.
 */
export function pairsThroughLink(c: ComputerInfo, throughPublicName: boolean, framed: boolean, pairing: FramePairing = 'not-paired'): boolean {
  return !!c.linked && !c.here && !throughPublicName && !framed && pairing === 'not-paired';
}

/** The question this page sends a computer's frame once it has loaded. */
export function frameAsk(): string {
  return FRAME_ASK;
}

/**
 * The framed page's answer to a message: only the page that frames it, asking the question, gets "paired". Being
 * paired is all it says, and only the other computers' pages may frame this one (frame-ancestors).
 */
export function frameAnswer(data: unknown, fromParent: boolean): string | null {
  return fromParent && data === FRAME_ASK ? FRAME_PAIRED : null;
}

/** Whether a message is a computer's frame saying it is paired: from that frame's window, at that computer's origin. */
export function framePaired(msg: { data: unknown; origin: string; fromFrame: boolean }, computerUrl: string): boolean {
  let origin: string;
  try { origin = new URL(computerUrl).origin; } catch { return false; }
  return msg.fromFrame && msg.origin === origin && msg.data === FRAME_PAIRED;
}

/** The other computer whose page shows, while it still has a tab; null: this computer's page. */
export function shownComputerOf(computers: ComputerInfo[], shown: string | null): string | null {
  return shown !== null && computers.some((c) => c.id === shown && !c.here) ? shown : null;
}

/** A push's link to another computer's tab (issue #451, server push.ts linkedPayload), `#/c/<public name>`: its id; null: not one. */
export function computerFromHash(hash: string): string | null {
  const m = /^#\/c\/([^/]+)$/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!).toLowerCase();
  } catch {
    return null;
  }
}

/** A computer's colour as the stylesheet's --cc-light and --cc-dark (.ctab, .page.remote, .remote-tag). */
export function computerStyle(c: ComputerInfo | null): CSSProperties | undefined {
  if (!c) return undefined;
  const { light, dark } = computerColour(c.colour);
  return { '--cc-light': light, '--cc-dark': dark } as CSSProperties;
}

/** This page is in a frame: another computer's Ledung page shows it (issue #241). */
export function inFrame(w: { self: unknown; top: unknown } = globalThis as never): boolean {
  return w.self !== w.top;
}

/**
 * A click on another computer's tab shows its page here (issue #241) rather than following the link: a plain
 * left click only, so a middle click or Ctrl/Cmd-click still opens that computer's page in a browser tab of its own.
 */
export function showsHere(e: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

/**
 * The count a tab's badge shows; 0 hides it. Another computer's: what waits there, as it told over the link (#273).
 * This computer's (#291): what Waiting for you counts here, only while another computer's page shows, so a question
 * here is not missed; on this computer's own page the sidebar already shows it, and a second badge is only noise.
 */
export function tabWaiting(c: ComputerInfo, shown: string | null, hereWaiting: number): number {
  if (!c.here) return c.waiting ?? 0;
  return shown === null ? 0 : hereWaiting;
}
