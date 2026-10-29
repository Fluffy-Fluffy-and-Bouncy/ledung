// The Board view of the page (read-only): who a post is from, where it went, and the list filters. Pure
// helpers, kept apart from the components so they can be tested.
import type { BoardPostView, BoardStatus, BoardThreadSummary } from '../../src/shared/protocol.ts';

/** The sidebar entry shows a Board view only while some project names a board repo. */
export const boardShown = (b: BoardStatus | null | undefined): boolean => !!b?.configured;

export const boardUnreadTotal = (b: BoardStatus | null | undefined): number => Object.values(b?.unread ?? {}).reduce((n, v) => n + v, 0);

/** A thread as the page addresses it: "bt:owner/name#12" (a repo never holds a "#"). */
export const threadOpenId = (repo: string, id: string): string => `bt:${repo}#${id}`;

export function parseThreadOpenId(openId: string | null): { repo: string; id: string } | null {
  const m = /^bt:([^#]+)#(.+)$/.exec(openId ?? '');
  return m ? { repo: m[1]!, id: m[2]! } : null;
}

/** The address of a thread: #/board/owner/name/<id>. */
export const threadHash = (repo: string, id: string): string => `#/board/${repo}/${encodeURIComponent(id)}`;

export function threadFromHash(hash: string): { repo: string; id: string } | null {
  const m = /^#\/board\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/([^/]+)$/.exec(hash);
  if (!m) return null;
  try {
    return { repo: m[1]!, id: decodeURIComponent(m[2]!) };
  } catch {
    return null;
  }
}

/** Who a post is from, as the service records it (never as the text claims). */
export function senderLabel(p: Pick<BoardPostView, 'author' | 'viaLedung' | 'fromProject' | 'mine'>, service: string): string {
  if (p.mine) return `this Ledung's manager of project ${p.fromProject ?? 'unknown'}`;
  if (p.viaLedung) return `@${p.author}'s Ledung${p.fromProject ? `, project ${p.fromProject}` : ''}`;
  return `typed on ${service} by @${p.author}`;
}

export interface DeliveryMark {
  text: string;
  /** ok: reached a manager; quiet: arrived without waking; warn: did not arrive; none: nothing to deliver. */
  level: 'ok' | 'quiet' | 'warn' | 'none';
  /** The project it went to, whose manager chat the page can open. */
  project?: string;
}

/** Where one post went: per project woke / quiet / channel / not delivered, or why it reached nobody. */
export function deliveryMarks(p: Pick<BoardPostView, 'author' | 'status' | 'deliveries'>): DeliveryMark[] {
  const marks: DeliveryMark[] = p.deliveries.map((d) => {
    switch (d.kind) {
      case 'wake': return { text: `woke ${d.project}`, level: 'ok', project: d.project };
      case 'quiet': return { text: `quiet to ${d.project}`, level: 'quiet', project: d.project };
      case 'channel': return { text: `channel, ${d.project}`, level: 'quiet', project: d.project };
      case 'ignored': return { text: `not delivered to ${d.project}: its allowlist does not name @${p.author}`, level: 'warn', project: d.project };
    }
  });
  if (marks.length) return marks;
  if (p.status === 'sent') return [{ text: 'sent from this Ledung', level: 'none' }];
  if (p.status === 'ignored') return [{ text: `not delivered: no project here allows @${p.author}; only the id was kept, not the text`, level: 'warn' }];
  if (p.status === 'quiet') return [{ text: 'not delivered: it reached no manager (no front desk, or the project\'s board is off)', level: 'warn' }];
  return [{ text: 'not for this Ledung', level: 'none' }];
}

export interface ThreadFilters {
  /** One of this Ledung's projects; '' for all. */
  project: string;
  /** "owner/name"; '' for all. */
  repo: string;
  unreadOnly: boolean;
  notDelivered: boolean;
}

export const NO_FILTERS: ThreadFilters = { project: '', repo: '', unreadOnly: false, notDelivered: false };

/** Some post of the thread did not reach a manager: dropped, refused by a project's allowlist, or for nobody's inbox. */
export const hasUndelivered = (t: BoardThreadSummary): boolean => t.dropped + t.refused + t.unsent > 0;

/** Unread posts in a thread: for one project, or in all. */
export const unreadIn = (t: BoardThreadSummary, project = ''): number =>
  project ? t.unread[project] ?? 0 : Object.values(t.unread).reduce((n, v) => n + v, 0);

export function filterThreads(threads: BoardThreadSummary[], f: ThreadFilters): BoardThreadSummary[] {
  return threads.filter((t) =>
    (!f.repo || t.repo === f.repo)
    && (!f.project || t.projects.includes(f.project))
    && (!f.unreadOnly || unreadIn(t, f.project) > 0)
    && (!f.notDelivered || hasUndelivered(t)));
}
