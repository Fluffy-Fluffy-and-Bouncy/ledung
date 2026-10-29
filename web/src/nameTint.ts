// The name colour of a session as a tint (mockup variant 3, issue #133): the message box in the colour of
// whom you are writing to, and each question in "Waiting for you" in the colour of whoever asked (#135).
// Kept apart from the components so it can be tested; the stylesheet (.composer.tinted, .name-tinted)
// turns the pair into a 5% tint and a 4px left edge.

import type { CSSProperties } from 'react';
import { NAME_COLOURS, nameColourFor } from '../../src/shared/name-colours.ts';
import { CHATS, projectLabel, type ChatsInfo, type ProjectInfo, type SessionInfo } from '../../src/shared/protocol.ts';

/**
 * The projects' name colours, with the chats' one colour (issue #222) as one more entry under the chats' own
 * project name: chats have no manager, so their sessions follow it ('same'). Every name lookup takes this list.
 */
export function withChatsColour(projects: Pick<ProjectInfo, 'name' | 'colours'>[], chats: Pick<ChatsInfo, 'colour'> | null): Pick<ProjectInfo, 'name' | 'colours'>[] {
  return [...projects, { name: CHATS, colours: { manager: chats?.colour ?? null, sessions: 'same' } }];
}

/**
 * A session's name colour as the light and dark values `.named` uses: its project's manager colour for a manager,
 * else its sessions' colour. Undefined for no colour (none set, a removed project, or a session no longer known),
 * which falls back to the page's accent and no tint.
 */
export function nameTint(session: Pick<SessionInfo, 'project' | 'role'> | undefined, projects: Pick<ProjectInfo, 'name' | 'colours'>[]): CSSProperties | undefined {
  if (!session) return undefined;
  const colour = nameColourFor(projects.find((p) => p.name === session.project)?.colours, session.role);
  if (!colour) return undefined;
  const c = NAME_COLOURS[colour];
  return { '--name-light': c.light, '--name-dark': c.dark } as CSSProperties;
}

/**
 * The label on a question's border (Martin, issue #135): "<tier> - <project>", so the history still shows what
 * kind of question it was; just the project for a question from before tiers, just the tier with no project.
 * Neither (an old question from a session no longer known): "Question", never an empty label (review of PR #136).
 */
export function questionLabel(tier: string | null, project: string): string {
  return [tier, project && projectLabel(project)].filter(Boolean).join(' - ') || 'Question';
}
