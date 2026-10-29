// A session's or project's name in its project's name colour (issue #83). The colour's light and
// dark values come from the palette; the stylesheet picks one for the theme (.named).
import type { CSSProperties, ReactNode } from 'react';
import { NAME_COLOURS, nameColourFor, type NameColour, type ProjectColours } from '../../../src/shared/name-colours.ts';
import type { ProjectInfo, SessionInfo } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';

export function Named({ colour, children }: { colour: NameColour | null; children: ReactNode }) {
  if (!colour) return <>{children}</>;
  const c = NAME_COLOURS[colour];
  return <span className="named" style={{ '--name-light': c.light, '--name-dark': c.dark } as CSSProperties}>{children}</span>;
}

/**
 * The two pickers in a project's tab in Settings, group Look (issue #83; moved there from the manager's ⚙ menu, Martin
 * 2026-10-28 in Ledung question #325, issue #366): the manager's name colour, and its sessions' ("same as the manager"
 * by default). Each can go back to no colour. Saved at once, for every browser.
 */
export function NameColourPickers({ project, run }: { project: ProjectInfo; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const save = (colours: ProjectColours) => run(() => api.setProjectColours(project.name, colours));
  const { manager, sessions } = project.colours;
  const keys = Object.keys(NAME_COLOURS) as NameColour[];
  const swatch = (key: NameColour, on: boolean, pick: () => void, what: string) => (
    <button key={key} type="button" className={`swatch${on ? ' on' : ''}`} aria-pressed={on} title={NAME_COLOURS[key].label}
      aria-label={`${what}: ${NAME_COLOURS[key].label}`} onClick={pick}>
      <Named colour={key}>●</Named>
    </button>
  );
  return (
    <div className="name-colours">
      <div className="name-colour-row" role="group" aria-label="Manager name colour">
        <div className="name-colour-head">
          <span className="name-colour-label field-name">Manager name</span>
          <button type="button" className={`small${manager === null ? ' on' : ''}`} aria-pressed={manager === null} onClick={() => save({ manager: null, sessions })}>None</button>
        </div>
        <div className="swatches">{keys.map((k) => swatch(k, manager === k, () => save({ manager: k, sessions }), 'Manager name'))}</div>
      </div>
      <div className="name-colour-row" role="group" aria-label="Its sessions' name colour">
        <div className="name-colour-head">
          <span className="name-colour-label field-name">Its sessions' names</span>
          <button type="button" className={`small${sessions === 'same' ? ' on' : ''}`} aria-pressed={sessions === 'same'} onClick={() => save({ manager, sessions: 'same' })}>Same as manager</button>
          <button type="button" className={`small${sessions === 'none' ? ' on' : ''}`} aria-pressed={sessions === 'none'} onClick={() => save({ manager, sessions: 'none' })}>None</button>
        </div>
        <div className="swatches">{keys.map((k) => swatch(k, sessions === k, () => save({ manager, sessions: k }), "Its sessions' names"))}</div>
      </div>
    </div>
  );
}

/**
 * The chats' one name colour (issue #222), in the Chats tab's Look group (#366): the same palette and "None" as a manager's
 * pickers. Chats have no manager, so there is one row. Saved at once, for every browser.
 */
export function ChatsColourPicker({ colour, run }: { colour: NameColour | null; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const save = (c: NameColour | null) => run(() => api.setChatsColour(c));
  return (
    <div className="name-colours">
      <div className="name-colour-row" role="group" aria-label="Chats' name colour">
        <div className="name-colour-head">
          <span className="name-colour-label field-name">Chats' names</span>
          <button type="button" className={`small${colour === null ? ' on' : ''}`} aria-pressed={colour === null} onClick={() => save(null)}>None</button>
        </div>
        <div className="swatches">
          {(Object.keys(NAME_COLOURS) as NameColour[]).map((k) => (
            <button key={k} type="button" className={`swatch${colour === k ? ' on' : ''}`} aria-pressed={colour === k} title={NAME_COLOURS[k].label}
              aria-label={`Chats' names: ${NAME_COLOURS[k].label}`} onClick={() => save(k)}>
              <Named colour={k}>●</Named>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The colour a session's name shows in, from its project (or the chats', withChatsColour); none for a removed project. */
export function sessionColour(session: SessionInfo, projects: Pick<ProjectInfo, 'name' | 'colours'>[]): NameColour | null {
  return nameColourFor(projects.find((p) => p.name === session.project)?.colours, session.role);
}
