// Which account's limits the sidebar strip shows: the selected project's, else the last one selected.
import type { ProjectInfo, SessionInfo } from '../../src/shared/protocol.ts';

export const DEFAULT_ACCOUNT = 'default';

/** The project a page id points at: a session's project, or a project's own page or settings. Other views have none. */
export function selectedProject(openId: string | null, sessions: Pick<SessionInfo, 'id' | 'project'>[]): string | null {
  if (!openId) return null;
  // A project tab's group follows a slash ("ps:Demo/look", issue #366); a project's name has none.
  const own = openId.match(/^ps?:([^/]+)/);
  if (own) return own[1]!;
  return sessions.find((s) => s.id === openId)?.project ?? null;
}

/**
 * The account for the strip. `remembered` is the account of the last selected project (kept by the page);
 * before anything was selected the first project's account is used. `remember` is true when the account
 * comes from a selection, so the page should store it.
 */
export function stripAccount(
  openId: string | null,
  sessions: Pick<SessionInfo, 'id' | 'project'>[],
  projects: Pick<ProjectInfo, 'name' | 'account'>[],
  remembered: string | null,
): { account: string; remember: boolean } {
  const project = projects.find((p) => p.name === selectedProject(openId, sessions));
  if (project) return { account: project.account ?? DEFAULT_ACCOUNT, remember: true };
  return { account: remembered ?? projects[0]?.account ?? DEFAULT_ACCOUNT, remember: false };
}

export const accountLabel = (account: string) => (account === DEFAULT_ACCOUNT ? 'Default' : account);

/** The account the sidebar names over a project: any but this computer's own login, which is never named (Martin, #394). */
export const projectAccountShown = (account: string | null | undefined): string | null =>
  account && account !== DEFAULT_ACCOUNT ? account : null;
