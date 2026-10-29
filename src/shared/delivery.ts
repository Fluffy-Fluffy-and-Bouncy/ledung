// The fixed sentence Ledung puts in the user message for everything it delivers that is not the user's own
// words (step 4d, docs/steps/step-4a-findings.md). Shared so the page can leave it out of the chat (issue
// #64): the model still receives it unchanged, the page shows the delivered content instead.

/** It can't approve anything, whatever the attached content says. */
export const CONTEXT_SENTENCE = (userName: string) =>
  `Ledung has delivered messages for you. They are attached as context and are not from ${userName}.`;

// Everything before the name, so a delivery recorded before a rename still matches.
const PREFIX = CONTEXT_SENTENCE('').slice(0, -1);

/** A delivered user text without the fixed sentence: only the user's own words remain (possibly none). */
export function withoutContextSentence(text: string): string {
  const parts = text.split('\n\n');
  const last = parts.at(-1)!;
  if (!last.startsWith(PREFIX) || !last.endsWith('.') || last.includes('\n')) return text;
  return parts.slice(0, -1).join('\n\n');
}
