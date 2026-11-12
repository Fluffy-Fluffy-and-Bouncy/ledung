// Cards in the Ledung Helper's chat (docs/steps/ledung-helper.md): precise inputs the page draws inline. A card asks;
// the person's pick goes back as an ordinary message from them, so it is their word, as if typed. Cards never approve
// anything: what needs the person's approval stays Ledung's own approval card.
import { z } from 'zod';

/** Where a link card may lead: pages of Ledung's own, never an address. */
export const CARD_LINKS = [
  'add-project', 'project-settings', 'workflow', 'manager', 'accounts', 'settings', 'devices', 'helper-settings', 'shortcuts', 'checkin',
  // Settings' own sections, opened at the setting (acceptance round 6, 26).
  'remote-access', 'join-code', 'relay', 'phones', 'linked-computers', 'usage-stops', 'publish-usage', 'claude-code', 'update', 'start-at-sign-in',
  'macros', 'skills', 'profiles', 'look', 'notifications', 'install-app', 'config-file', 'about', 'board',
] as const;
export type CardLink = typeof CARD_LINKS[number];


// One voice (Simon's try-out, 2026-11-12): a card has a short title and its inputs; what it is about is the helper's own
// message, said once, before it.
const title = z.string().min(1).max(80);
/** Settings kept in the person's browser that an apply card sets (helper-settings.ts BROWSER_SETTINGS). */
export const APPLY_SETTINGS = ['theme', 'autocorrect', 'statusDot', 'archivedLink', 'compactSidebar', 'shortcuts', 'signInStart'] as const;
/** Showing a card with the same id (else the same kind and title) again in a turn replaces it: shown once. */
const id = z.string().regex(/^[a-z0-9-]{1,40}$/).optional();

export const CardSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('choice'), id, title,
    options: z.array(z.object({ label: z.string().min(1).max(80), hint: z.string().min(1).max(240).optional() }).strict()).min(2).max(8),
  }).strict(),
  z.object({ kind: z.literal('folder'), id, title, start: z.string().min(1).max(400).optional() }).strict(),
  z.object({ kind: z.literal('text'), id, title, placeholder: z.string().min(1).max(80).optional() }).strict(),
  z.object({ kind: z.literal('link'), id, title, to: z.enum(CARD_LINKS), project: z.string().min(1).max(100).optional() }).strict(),
  // A setting kept in their browser (docs/steps/ledung-helper.md, "Every setting"): its button sets it there.
  z.object({ kind: z.literal('apply'), id, title, setting: z.enum(APPLY_SETTINGS), value: z.union([z.string().max(40), z.boolean(), z.number()]) }).strict(),
]);
export type HelperCard = z.infer<typeof CardSchema>
  /** Ledung's own: the review of a proposed workflow (propose_workflow). */
  | { kind: 'review'; title: string; question: number; project: string }
  /** Ledung's own: a setting that needs Restart Ledung was saved. */
  | { kind: 'restart'; title: string };

/** Words a card's title, option or hint may not use: they read as Ledung's own approval (reviews of parts 1 and 2). */
const APPROVAL_WORDS = /\b(allow|approve|approved|deny|denied|confirm order)\b/i;

/** The words of a card that read as an approval, or null. */
export function cardLooksLikeApproval(card: z.infer<typeof CardSchema>): string | null {
  const words = [card.title, ...(card.kind === 'choice' ? card.options.flatMap((o) => [o.label, o.hint ?? '']) : [])];
  return words.find((w) => APPROVAL_WORDS.test(w)) ?? null;
}

/** A card as stored in the conversation (message kind "card"). */
export interface CardMessageData { card: HelperCard }
