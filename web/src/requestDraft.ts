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

/** Nothing picked, judged or written: a draft that must never replace one kept in Ledung (acceptance round 1). */
export function isEmptyDraft(d: RequestDraft): boolean {
  return !Object.values(d.decisions).some((a) => a.pick !== undefined || a.other?.trim())
    && !d.signOff.verdict && !d.signOff.note.trim()
    && !Object.values(d.judged).some((j) => j?.verdict || j?.note.trim())
    && !d.note.trim();
}

// A shot's verdict as it is compared: an empty one (nothing judged or written) is the same as none. A decision is
// compared as it is: `{ other: '' }` is "Other" chosen, its box still empty.
const judgedPart = (j: ShotJudgement | undefined) => (j && (j.verdict || j.note.trim()) ? j : undefined);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Three drafts made one, part by part (a decision, a shot's verdict, the sign-off's verdict and note, the note):
 * `base` is the version this page last read, `here` what the page holds now, `kept` the newer version in Ledung.
 * A part this page changed since `base` is its own; every other part is Ledung's. So a page left open on the PC
 * takes up the phone's picks without losing what was typed here, and never puts its old copy back over them
 * (acceptance round 2). With an empty `base`, everything done here goes over the kept draft (round 1).
 */
export function rebaseDraft(base: RequestDraft, here: RequestDraft, kept: RequestDraft): RequestDraft {
  const decisions: RequestDraft['decisions'] = {};
  for (const k of new Set([...Object.keys(base.decisions), ...Object.keys(here.decisions), ...Object.keys(kept.decisions)])) {
    const [b, h, n] = [base.decisions[k], here.decisions[k], kept.decisions[k]];
    const v = same(b, h) ? n : h;
    if (v) decisions[k] = v;
  }
  const judged: RequestDraft['judged'] = {};
  for (const k of new Set([...Object.keys(base.judged), ...Object.keys(here.judged), ...Object.keys(kept.judged)].map(Number))) {
    const [b, h, n] = [judgedPart(base.judged[k]), judgedPart(here.judged[k]), judgedPart(kept.judged[k])];
    const v = same(b, h) ? n : h;
    if (v) judged[k] = v;
  }
  const verdict = base.signOff.verdict === here.signOff.verdict ? kept.signOff.verdict : here.signOff.verdict;
  return {
    decisions,
    signOff: { ...(verdict ? { verdict } : {}), note: base.signOff.note === here.signOff.note ? kept.signOff.note : here.signOff.note },
    judged,
    note: base.note === here.note ? kept.note : here.note,
  };
}

/** Whether two drafts say the same: nothing in one that the other lacks, part by part. */
export function sameDraft(a: RequestDraft, b: RequestDraft): boolean {
  return same(canonical(a), canonical(b));
}
// The draft with its empty parts left out and its keys in order.
const canonical = (d: RequestDraft) => {
  const r = rebaseDraft(emptyRequestDraft(), emptyRequestDraft(), d);
  const sort = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return { ...r, decisions: sort(r.decisions), judged: sort(r.judged as Record<string, ShotJudgement>) };
};

/** A request's draft kept anew in Ledung, from the live connection: its open pages read it (acceptance round 2). */
const draftListeners = new Set<(questionId: number, at: number) => void>();
export function draftChanged(questionId: number, at: number): void {
  for (const f of draftListeners) f(questionId, at);
}
export function onDraftChanged(f: (questionId: number, at: number) => void): () => void {
  draftListeners.add(f);
  return () => { draftListeners.delete(f); };
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
