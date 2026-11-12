// Cards in the Ledung Helper's chat (docs/steps/ledung-helper.md): precise inputs the page draws inline. A card asks;
// the person's pick goes back as an ordinary message from them, so it is their word, as if typed. Cards never approve
// anything: what needs the person's approval stays Ledung's own approval card.
import { z } from 'zod';

/** Where a link card may lead: pages of Ledung's own, never an address. */
export const CARD_LINKS = ['add-project', 'project-settings', 'workflow', 'manager', 'accounts', 'settings', 'devices', 'helper-settings', 'shortcuts', 'checkin'] as const;
export type CardLink = typeof CARD_LINKS[number];

/** The page controls a step card shows: the person presses them. */
export const CARD_STEPS = ['shortcuts', 'checkin', 'phone', 'accounts'] as const;
export type CardStep = typeof CARD_STEPS[number];

const title = z.string().min(1).max(120);
const text = z.string().min(1).max(1200).optional();

export const CardSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('choice'), title, text,
    options: z.array(z.object({ label: z.string().min(1).max(80), hint: z.string().min(1).max(240).optional() }).strict()).min(2).max(8),
  }).strict(),
  z.object({ kind: z.literal('folder'), title, text, start: z.string().min(1).max(400).optional() }).strict(),
  z.object({ kind: z.literal('text'), title, text, placeholder: z.string().min(1).max(80).optional() }).strict(),
  z.object({ kind: z.literal('step'), title, text, step: z.enum(CARD_STEPS) }).strict(),
  z.object({ kind: z.literal('link'), title, text, to: z.enum(CARD_LINKS), project: z.string().min(1).max(100).optional() }).strict(),
]);
export type HelperCard = z.infer<typeof CardSchema>
  /** Ledung's own: the review of a proposed workflow (propose_workflow). */
  | { kind: 'review'; title: string; text?: string; question: number; project: string };

/** A card as stored in the conversation (message kind "card"). */
export interface CardMessageData { card: HelperCard }
