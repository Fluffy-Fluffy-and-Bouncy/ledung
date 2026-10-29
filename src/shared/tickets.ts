// Ticket ids found with a project's pattern, as links (step 5c). Shared: the Overview finds them in the
// core, Waiting for you links a question's refs in the page (issue #59).
import type { TicketLink } from './protocol.ts';

/** Ticket ids in the given texts, as links, in order of first appearance. */
export function findTickets(texts: (string | null | undefined)[], config: { pattern: string; url: string } | undefined): TicketLink[] {
  if (!config) return [];
  const seen = new Set<string>();
  const out: TicketLink[] = [];
  let re: RegExp;
  try {
    re = new RegExp(config.pattern, 'g');
  } catch {
    return [];
  }
  for (const text of texts) {
    for (const m of (text ?? '').matchAll(re)) {
      const id = m[0];
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, url: config.url.replace('{id}', encodeURIComponent(id)) });
    }
  }
  return out;
}
