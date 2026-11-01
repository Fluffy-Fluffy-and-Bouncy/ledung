// The Look settings of a computer shown in a frame on another computer's page (issue #459). On an iPhone a page
// framed by a sibling name (one computer's <name>.l.<domain> framing another's) counts as third-party, and WebKit
// gives it a localStorage of its own that is not kept (partitioned and ephemeral: WebKit bugs 228856 and 231879), so
// a theme or sidebar choice made in that computer's tab was gone again. The page that frames it keeps them in its own
// storage, one entry per computer, and hands them back each time the frame's page loads. Only these settings, and
// only between a frame and the page that frames it: nothing reaches either Ledung's server.
import { THEME_KEY } from './theme.ts';
import { AUTOCORRECT_KEY } from './plainTyping.ts';
import { STATUS_DOT_KEY } from './statusDot.ts';
import { ARCHIVED_LINK_KEY } from './archivedLink.ts';
import { COMPACT_KEY } from './compactSidebar.ts';
import { framePaired } from './computerFrame.ts';

/** Settings → Look's choices kept per browser (Appearance, Typing, Sidebar). */
export const FRAME_SETTING_KEYS: readonly string[] = [THEME_KEY, AUTOCORRECT_KEY, STATUS_DOT_KEY, ARCHIVED_LINK_KEY, COMPACT_KEY];

/** Each value is a short word or number; anything longer is not one of them. */
const MAX_VALUE = 16;

const ASK = 'ledung:settings?';
const ANSWER = 'ledung:settings';
const SAVE = 'ledung:setting';

export type FrameSettings = Record<string, string>;
export type SettingsStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type FrameSettingsMessage =
  | { type: typeof ASK }
  | { type: typeof ANSWER; settings: FrameSettings | null }
  | { type: typeof SAVE; key: string; value: string | null };

const isKey = (key: unknown): key is string => typeof key === 'string' && FRAME_SETTING_KEYS.includes(key);
const isValue = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_VALUE;
const record = (data: unknown): Record<string, unknown> | null =>
  typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : null;

/** Only the known settings with a plausible value; anything else is dropped. */
function onlySettings(data: unknown): FrameSettings {
  const out: FrameSettings = {};
  for (const [k, v] of Object.entries(record(data) ?? {})) if (isKey(k) && isValue(v)) out[k] = v;
  return out;
}

/** The framing page's entry for one computer's settings. */
export function frameSettingsKey(computerId: string): string {
  return `ledung.frameSettings.${computerId}`;
}

/** What the framing page keeps for a computer; null: nothing yet (that frame never sent any). */
export function keptSettings(store: SettingsStore, computerId: string): FrameSettings | null {
  try {
    const raw = store.getItem(frameSettingsKey(computerId));
    return raw === null ? null : onlySettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

// The framing page's side.

/**
 * The framing page's handling of a message from a computer's frame: only from that frame's window, at that
 * computer's origin (as framePaired). An ask is answered with what it keeps; a save is kept and needs no answer.
 * Returns the answer to send back to the frame, or null.
 */
export function frameSettingsReply(
  msg: { data: unknown; origin: string; fromFrame: boolean }, computerUrl: string, computerId: string, store: SettingsStore,
): FrameSettingsMessage | null {
  let origin: string;
  try { origin = new URL(computerUrl).origin; } catch { return null; }
  if (!msg.fromFrame || msg.origin !== origin) return null;
  const data = record(msg.data);
  if (data?.type === ASK) return { type: ANSWER, settings: keptSettings(store, computerId) };
  if (data?.type === SAVE && isKey(data.key) && (data.value === null || isValue(data.value))) {
    const kept = { ...keptSettings(store, computerId) };
    if (data.value === null) delete kept[data.key];
    else kept[data.key] = data.value;
    try { store.setItem(frameSettingsKey(computerId), JSON.stringify(kept)); } catch { /* private mode: kept for this visit only */ }
  }
  return null;
}

/**
 * One message on the framing page, for one computer's frame (ComputerFrames): its settings answered through `reply`
 * (to that frame's window at its origin), then whether it is that frame saying it is paired (#286).
 */
export function frameMessage(
  msg: { data: unknown; origin: string; fromFrame: boolean }, computer: { id: string; url: string }, store: SettingsStore,
  reply: (answer: FrameSettingsMessage) => void,
): boolean {
  const answer = frameSettingsReply(msg, computer.url, computer.id, store);
  if (answer) reply(answer);
  return framePaired(msg, computer.url);
}

// The framed page's side.

/** The question the framed page sends the page that frames it as it starts. */
export function frameSettingsAsk(): FrameSettingsMessage {
  return { type: ASK };
}

/**
 * The settings in the framing page's answer: only from the page that frames this one. undefined: not that answer;
 * null: it keeps none for this computer yet.
 */
export function answeredSettings(data: unknown, fromParent: boolean): FrameSettings | null | undefined {
  const d = record(data);
  if (!fromParent || d?.type !== ANSWER) return undefined;
  return d.settings === null ? null : onlySettings(d.settings);
}

/** Puts the framing page's settings in this page's storage: those it keeps set, the others back to their default. */
export function takeSettings(store: SettingsStore, settings: FrameSettings): void {
  try {
    for (const key of FRAME_SETTING_KEYS) {
      const value = settings[key];
      if (value === undefined) store.removeItem(key);
      else store.setItem(key, value);
    }
  } catch { /* private mode: kept for this visit only */ }
}

/**
 * This page's own settings as saves, for a framing page that keeps none yet: the first time after this change, so
 * a frame whose storage was kept (a computer's own page in a desktop browser) keeps its choices instead of losing them.
 */
export function ownSettings(store: SettingsStore): FrameSettingsMessage[] {
  const saves: FrameSettingsMessage[] = [];
  try {
    for (const key of FRAME_SETTING_KEYS) {
      const value = store.getItem(key);
      if (isValue(value)) saves.push({ type: SAVE, key, value });
    }
  } catch { /* storage refused: nothing to send */ }
  return saves;
}

/** A store that saves as `base` does and also sends each of these settings to `send` (the framing page, if any). */
export function mirroredStore(base: () => SettingsStore, send: (msg: FrameSettingsMessage) => void): SettingsStore {
  return {
    getItem: (key) => base().getItem(key),
    setItem: (key, value) => {
      base().setItem(key, value);
      if (isKey(key) && isValue(value)) send({ type: SAVE, key, value });
    },
    removeItem: (key) => {
      base().removeItem(key);
      if (isKey(key)) send({ type: SAVE, key, value: null });
    },
  };
}
