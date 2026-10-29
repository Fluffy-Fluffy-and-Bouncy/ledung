// The skill picker (#300): which of the user's own skills managers and sessions get, a tick per skill and
// role. In Settings it edits the defaults; in a project's ⚙ the project's own choices over them (Martin's a
// on question #659, with "I want to specify the default for workers and managers. That can ofc be over ruled
// per project."). Plugin skills are not here: they go on and off with their plugin, in the profile.
import { useEffect, useState } from 'react';
import type { SkillListView } from '../../../src/shared/protocol.ts';
import {
  chooseSkill, newSkillsFor, skillChosen, skillOn, type SkillChoices, type SkillRole, type SkillSource,
} from '../../../src/shared/skills.ts';
import { api } from '../api.ts';

const ROLES: { role: SkillRole; label: string }[] = [{ role: 'manager', label: 'Manager' }, { role: 'session', label: 'Sessions' }];
const SOURCE_LABEL: Record<SkillSource, string> = { personal: 'Personal', 'claude.ai': 'From claude.ai' };

/** The skills where a project's sessions run (none: this computer's own login); null while loading. */
export function useSkillList(project: string | undefined): { list: SkillListView | null; error: string | null } {
  const [list, setList] = useState<SkillListView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setList(null);
    setError(null);
    api.skills(project).then((l) => { if (current) setList(l); }, (e: Error) => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [project]);
  return { list, error };
}

/**
 * The picker. `defaults` null: it edits the defaults themselves (Settings); otherwise a project's own
 * choices over these defaults, and a skill it hasn't chosen shows the default's tick.
 */
export function SkillPicker({ list, error, value, onChange, defaults }: {
  list: SkillListView | null; error: string | null; value: SkillChoices; onChange: (c: SkillChoices) => void; defaults: SkillChoices | null;
}) {
  if (error) return <p className="error">Couldn't list the skills: {error}</p>;
  if (!list) return <p className="muted">Looking for your skills…</p>;
  const base = defaults ?? {};
  const project = defaults ? value : undefined;
  const on = (name: string, role: SkillRole) => (defaults ? skillOn(name, role, base, project) : skillOn(name, role, value, undefined));
  const found = new Set(list.skills.map((s) => s.name));
  // Chosen but no longer there: kept until cleared, so a skill that comes back keeps its choice.
  const gone = [...new Set(ROLES.flatMap(({ role }) => [...(value[role]?.on ?? []), ...(value[role]?.off ?? [])]))].filter((n) => !found.has(n)).sort();
  const setNew = (role: SkillRole, v: 'on' | 'off' | null) => {
    const r = { ...value[role] };
    if (v === null) delete r.newSkills;
    else r.newSkills = v;
    onChange({ ...value, [role]: r });
  };
  const groups = (['personal', 'claude.ai'] as const).map((source) => ({ source, skills: list.skills.filter((s) => s.source === source) })).filter((g) => g.skills.length);
  return (
    <div className="skill-picker">
      <table>
        <thead>
          <tr><th>Skill</th>{ROLES.map(({ role, label }) => <th key={role}>{label}</th>)}</tr>
        </thead>
        <tbody>
          <tr className="skill-new">
            <td>
              <strong>New skills</strong>
              <div className="muted">A skill with no tick chosen{defaults ? ' here or in Settings' : ''}, such as one you add later.</div>
            </td>
            {ROLES.map(({ role, label }) => (
              <td key={role}>
                {defaults ? (
                  <select aria-label={`New skills, ${label}`} value={value[role]?.newSkills ?? ''} onChange={(e) => setNew(role, (e.target.value || null) as 'on' | 'off' | null)}>
                    <option value="">Settings: {newSkillsFor(role, base, undefined)}</option>
                    <option value="on">on</option>
                    <option value="off">off</option>
                  </select>
                ) : (
                  <select aria-label={`New skills, ${label}`} value={newSkillsFor(role, value, undefined)} onChange={(e) => setNew(role, e.target.value as 'on' | 'off')}>
                    <option value="on">on</option>
                    <option value="off">off</option>
                  </select>
                )}
              </td>
            ))}
          </tr>
          {groups.map((g) => [
            <tr key={`h-${g.source}`} className="skill-group"><td colSpan={3}>{SOURCE_LABEL[g.source]}</td></tr>,
            ...g.skills.map((s) => (
              <tr key={s.name}>
                <td><span className="mono">{s.name}</span>{s.description && <div className="muted">{s.description}</div>}</td>
                {ROLES.map(({ role, label }) => {
                  const own = skillChosen(value, role, s.name);
                  return (
                    <td key={role}>
                      <input type="checkbox" aria-label={`${s.name}, ${label}`} checked={on(s.name, role)} onChange={(e) => onChange(chooseSkill(value, role, s.name, e.target.checked))} />
                      {defaults && own && (
                        <button type="button" className="small skill-clear" title="Follow Settings again" onClick={() => onChange(chooseSkill(value, role, s.name, null))}>here ✕</button>
                      )}
                    </td>
                  );
                })}
              </tr>
            )),
          ])}
          {gone.length > 0 && <tr className="skill-group"><td colSpan={3}>Not on this computer any more</td></tr>}
          {gone.map((n) => (
            <tr key={`gone-${n}`} className="skill-gone">
              <td><span className="mono">{n}</span></td>
              {ROLES.map(({ role, label }) => (
                <td key={role}>
                  {skillChosen(value, role, n) && (
                    <button type="button" className="small skill-clear" aria-label={`Clear ${n}, ${label}`} onClick={() => onChange(chooseSkill(value, role, n, null))}>
                      {value[role]?.on?.includes(n) ? 'on' : 'off'} ✕
                    </button>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!list.skills.length && <p className="muted">No skills of your own were found{defaults ? ' where this project runs' : ' on this computer'}.</p>}
      {list.plugins.length > 0 && (
        <p className="muted">
          Plugin skills go on and off with their plugin, in the session profile: {list.plugins.join(', ')}.
        </p>
      )}
    </div>
  );
}

/** How many of the skills are on per role, for a folded picker's summary. */
export function skillCounts(list: SkillListView | null, value: SkillChoices, defaults: SkillChoices | null): string {
  if (!list) return '';
  const n = list.skills.length;
  const count = (role: SkillRole) => list.skills.filter((s) => (defaults ? skillOn(s.name, role, defaults, value) : skillOn(s.name, role, value, undefined))).length;
  return `manager ${count('manager')} of ${n}, sessions ${count('session')} of ${n}`;
}

/** Settings → Skills: the defaults every project follows unless it chooses otherwise. */
export function SkillDefaults({ run }: { run: (action: () => Promise<unknown>) => Promise<void> }) {
  const { list, error } = useSkillList(undefined);
  const [value, setValue] = useState<SkillChoices | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (list && value === null) setValue(list.defaults); }, [list]);
  return (
    <section>
      <h3>Skills</h3>
      <p className="muted">
        Which of your own skills managers and sessions get, unless a project's ⚙ says otherwise. Running sessions keep theirs; new and resumed ones get these.
      </p>
      <details>
        <summary>Default skills{list && value ? `: ${skillCounts(list, value, null)}` : ''}</summary>
        <SkillPicker list={list} error={error} value={value ?? {}} onChange={(c) => { setValue(c); setSaved(false); }} defaults={null} />
        <button className="primary" disabled={!value} onClick={() => void run(async () => { setValue(await api.setSkillDefaults(value ?? {})); setSaved(true); })}>Save</button>
        {saved && <span className="muted"> Saved.</span>}
      </details>
    </section>
  );
}
