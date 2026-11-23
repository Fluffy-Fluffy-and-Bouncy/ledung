// A request's draft on the page (issue #502): every pick, verdict and note as the person gives them, kept in Ledung
// (D4) so it follows them from the PC to the phone and back, and in this tab for the list's "3 to answer" chip. Pure
// apart from the map, for tests.
import type { ShotJudgement } from '../../src/shared/shots.ts';
import type { AnswerParts, RequestModel } from '../../src/shared/requests.ts';

export interface RequestDraft {
  /** By decision key: the option picked, or the person's own words. */
  decisions: Record<string, { pick?: string; other?: string }>;
  signOff: { verdict?: 'accept' | 'changes'; note: string };
  /** By the shot's place in the question. */
  judged: Record<number, ShotJudgement>;
  note: string;
}

export const emptyRequestDraft = (): RequestDraft => ({ decisions: {}, signOff: { note: '' }, judged: {}, note: '' });

/** Drafts seen in this tab, by question: the list's chip reads them. */
export const requestDrafts = new Map<number, RequestDraft>();

/** A draft read back from Ledung, whatever it holds: anything not a draft's shape is left out. */
export function readDraft(data: unknown): RequestDraft | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<RequestDraft>;
  const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {});
  const decisions: RequestDraft['decisions'] = {};
  for (const [k, v] of Object.entries(obj(d.decisions))) {
    const a = obj(v);
    decisions[k] = { ...(typeof a.pick === 'string' ? { pick: a.pick } : {}), ...(typeof a.other === 'string' ? { other: a.other } : {}) };
  }
  const s = obj(d.signOff);
  const judged: RequestDraft['judged'] = {};
  for (const [k, v] of Object.entries(obj(d.judged))) {
    const j = obj(v);
    const verdict = j.verdict === 'pass' || j.verdict === 'fail' || j.verdict === 'unsure' ? j.verdict : null;
    if (/^\d+$/.test(k)) judged[Number(k)] = { verdict, note: typeof j.note === 'string' ? j.note : '' };
  }
  return {
    decisions,
    signOff: { ...(s.verdict === 'accept' || s.verdict === 'changes' ? { verdict: s.verdict } : {}), note: typeof s.note === 'string' ? s.note : '' },
    judged,
    note: typeof d.note === 'string' ? d.note : '',
  };
}

/** The draft as the parts the answer is built from (requestAnswer checks them). */
export function draftParts(m: RequestModel, d: RequestDraft): AnswerParts {
  const parts: AnswerParts = {};
  if (m.decisions.length) {
    parts.decisions = m.decisions.map((x) => {
      const a = d.decisions[x.key] ?? {};
      return a.pick !== undefined ? { key: x.key, pick: a.pick } : { key: x.key, ...(a.other?.trim() ? { other: a.other } : {}) };
    });
  }
  if (m.signOff && d.signOff.verdict) parts.signOff = { verdict: d.signOff.verdict, ...(d.signOff.note.trim() ? { note: d.signOff.note } : {}) };
  if (m.shots) parts.shots = Array.from({ length: m.shots }, (_, i) => ({ verdict: d.judged[i]?.verdict ?? null, ...(d.judged[i]?.note.trim() ? { note: d.judged[i]!.note } : {}) }));
  if (d.note.trim()) parts.note = d.note;
  return parts;
}

/** The parts still to answer, in page order: each decision by its key, then "sign-off" (shots never block Send). */
export function openParts(m: RequestModel, d: RequestDraft): string[] {
  const out = m.decisions.filter((x) => {
    const a = d.decisions[x.key];
    return !(a && ((a.pick !== undefined && x.options.some((o) => o.key === a.pick)) || a.other?.trim()));
  }).map((x) => `d:${x.key}`);
  if (m.signOff && !(d.signOff.verdict === 'accept' || (d.signOff.verdict === 'changes' && d.signOff.note.trim()))) out.push('sign-off');
  return out;
}

/** Alt+↓ / Alt+↑: the next or previous part still open after `from` (a part's id, or null for the top), wrapping. */
export function nextOpen(order: readonly string[], open: readonly string[], from: string | null, dir: 1 | -1): string | null {
  if (!open.length) return null;
  const at = from === null ? (dir === 1 ? -1 : order.length) : order.indexOf(from);
  for (let i = 1; i <= order.length; i++) {
    const id = order[(((at + dir * i) % order.length) + order.length) % order.length]!;
    if (open.includes(id)) return id;
  }
  return null;
}
