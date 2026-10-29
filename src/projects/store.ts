// Projects (projects and accounts, P1): kept in Ledung's database and managed in the page. Each is a
// place where Claude Code runs, its settings, and its one manager. Projects still listed in the
// config file are copied in once each, by name, so a project removed in the page doesn't come back.
import type { DatabaseSync } from 'node:sqlite';
import { parseProject, type ProjectConfig } from '../config.ts';
import { LATER_SUGGESTIONS, withSuggestions } from '../shared/sensitive-suggestions.ts';
import { NO_COLOURS, parseColours, type ProjectColours } from '../shared/name-colours.ts';

export interface StoredProject {
  config: ProjectConfig;
  /** Its manager, once it has been started. */
  managerId: string | null;
  createdAt: number;
  /** Its name colours (issue #83). */
  colours: ProjectColours;
}

const IMPORTED_KEY = 'projects-imported';
const SUGGESTIONS_KEY = 'sensitive-suggestions-added';

export class ProjectStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private row(r: Record<string, any>): StoredProject {
    return { config: parseProject(JSON.parse(r.data)), managerId: r.manager_id ?? null, createdAt: Number(r.created_at), colours: readColours(r.colours) };
  }

  list(): StoredProject[] {
    return (this.db.prepare('SELECT * FROM projects WHERE removed_at IS NULL ORDER BY position IS NULL, position, created_at').all() as Record<string, any>[])
      .flatMap((r) => {
        try {
          return [this.row(r)];
        } catch (e) {
          console.error(`Project "${r.name}" has settings Ledung can't read: ${(e as Error).message}`);
          return [];
        }
      });
  }

  /**
   * Removed projects whose settings can still be read, without a live one of the same name: publishing usage keeps
   * sending a removed project's usage to the repo it last named (Martin, 2026-10-28, Ledung question #366, issue #380).
   */
  removed(): StoredProject[] {
    const live = new Set(this.list().map((p) => p.config.name));
    return (this.db.prepare('SELECT * FROM projects WHERE removed_at IS NOT NULL ORDER BY removed_at DESC').all() as Record<string, any>[])
      .flatMap((r) => {
        if (live.has(r.name)) return [];
        try {
          return [this.row(r)];
        } catch {
          return [];
        }
      });
  }

  get(name: string): StoredProject | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE name = ? AND removed_at IS NULL').get(name) as Record<string, any> | undefined;
    return r ? this.row(r) : undefined;
  }

  /** Adds a project; a removed one with the same name is replaced (its sessions keep their history). */
  add(config: ProjectConfig, managerId: string | null = null): StoredProject {
    const project = parseProject(config);
    if (this.get(project.name)) throw new Error(`There is already a project named "${project.name}".`);
    this.db.prepare('DELETE FROM projects WHERE name = ?').run(project.name);
    this.db.prepare('INSERT INTO projects (name, data, manager_id, created_at) VALUES (?, ?, ?, ?)')
      .run(project.name, JSON.stringify(project), managerId, Date.now());
    return this.get(project.name)!;
  }

  /** New settings; the name and where the project is stay as they are. */
  update(name: string, config: ProjectConfig): StoredProject {
    const current = this.get(name);
    if (!current) throw new Error(`There is no project named "${name}".`);
    const where = current.config.runner === 'local'
      ? { runner: 'local' as const, path: current.config.path }
      : { runner: 'docker' as const, container: current.config.container, pathInContainer: current.config.pathInContainer, user: current.config.user };
    const project = parseProject({ ...config, ...where, name });
    this.db.prepare('UPDATE projects SET data = ? WHERE name = ?').run(JSON.stringify(project), name);
    return this.get(name)!;
  }

  /**
   * A new name (issue #116). Everything stored under the old one moves with it in one transaction: its
   * sessions (so its manager, questions and permission requests, which hang off them), usage and turn
   * records, and its board setting, deliveries, posts and front desk. Its folder is not touched. A name
   * another project has, or one the name rules refuse, changes nothing. A removed project's row with the
   * new name is replaced, as add does.
   */
  rename(from: string, to: string): StoredProject {
    const current = this.get(from);
    if (!current) throw new Error(`There is no project named "${from}".`);
    const project = parseProject({ ...current.config, name: to });
    if (project.name === from) return current;
    if (this.get(project.name)) throw new Error(`There is already a project named "${project.name}".`);
    const moves = [
      'UPDATE sessions SET project = ? WHERE project = ?',
      'UPDATE usage SET project = ? WHERE project = ?',
      'UPDATE turn_resources SET project = ? WHERE project = ?',
      'UPDATE board_projects SET name = ? WHERE name = ?',
      'UPDATE board_boards SET front_desk = ? WHERE front_desk = ?',
      // OR REPLACE: a removed project with the new name may have had the same post delivered.
      'UPDATE OR REPLACE board_deliveries SET project = ? WHERE project = ?',
      'UPDATE board_posts SET from_project = ? WHERE from_project = ?',
      'UPDATE board_outbox SET project = ? WHERE project = ?',
    ];
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM projects WHERE name = ? AND removed_at IS NOT NULL').run(project.name);
      this.db.prepare('DELETE FROM board_projects WHERE name = ?').run(project.name);
      this.db.prepare('UPDATE projects SET name = ?, data = ? WHERE name = ? AND removed_at IS NULL').run(project.name, JSON.stringify(project), from);
      // Its manager's title, while it is still the one Ledung gave it ("Manager: <project>", start).
      this.db.prepare(`UPDATE sessions SET title = ? WHERE project = ? AND role = 'manager' AND title = ?`).run(`Manager: ${project.name}`, from, `Manager: ${from}`);
      for (const sql of moves) this.db.prepare(sql).run(project.name, from);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.get(project.name)!;
  }

  /**
   * Once, the first time Ledung runs with this code: adds the starting suggestions to every project's
   * sensitive list (sensitive-always, decision of 2026-10-12), keeping what is there and not duplicating
   * it. After this the list is the user's: a suggestion deleted later never comes back by itself.
   * Suggestions added to the code later (LATER_SUGGESTIONS, e.g. elevation, #213) are copied in the same
   * way, once per batch. Returns how many projects changed (0 when it has all run before).
   */
  addSuggestionsOnce(): number {
    const changed = new Set<string>();
    const once = (key: string, add: (sensitive: ProjectConfig['sensitive']) => ProjectConfig['sensitive']) => {
      if (this.db.prepare('SELECT 1 FROM meta WHERE key = ?').get(key)) return;
      for (const p of this.list()) {
        const sensitive = add(p.config.sensitive);
        if (sensitive.commandPatterns.length === p.config.sensitive.commandPatterns.length
          && sensitive.pathPatterns.length === p.config.sensitive.pathPatterns.length) continue;
        this.db.prepare('UPDATE projects SET data = ? WHERE name = ?').run(JSON.stringify({ ...p.config, sensitive }), p.config.name);
        changed.add(p.config.name);
      }
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, new Date().toISOString());
    };
    once(SUGGESTIONS_KEY, withSuggestions);
    for (const batch of LATER_SUGGESTIONS) {
      once(batch.key, (s) => ({ ...s, commandPatterns: [...s.commandPatterns, ...batch.commandPatterns.filter((p) => !s.commandPatterns.includes(p))] }));
    }
    return changed.size;
  }

  /** New name colours (issue #83); anything outside the palette is refused. */
  setColours(name: string, colours: unknown): StoredProject {
    if (!this.get(name)) throw new Error(`There is no project named "${name}".`);
    const parsed = parseColours(colours);
    const none = parsed.manager === null && parsed.sessions === 'same';
    this.db.prepare('UPDATE projects SET colours = ? WHERE name = ?').run(none ? null : JSON.stringify(parsed), name);
    return this.get(name)!;
  }

  /**
   * The sidebar order (issue #88): the names given first, in that order, then any project not named in
   * the order it had, so a project added meanwhile is kept, last.
   */
  setOrder(names: string[]): void {
    const current = this.list().map((p) => p.config.name);
    if (new Set(names).size !== names.length) throw new Error('A project is named twice in the order.');
    const unknown = names.find((n) => !current.includes(n));
    if (unknown !== undefined) throw new Error(`There is no project named "${unknown}".`);
    const order = [...names, ...current.filter((n) => !names.includes(n))];
    const set = this.db.prepare('UPDATE projects SET position = ? WHERE name = ? AND removed_at IS NULL');
    this.db.exec('BEGIN');
    try {
      order.forEach((name, i) => set.run(i, name));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  setManager(name: string, managerId: string): void {
    this.db.prepare('UPDATE projects SET manager_id = ? WHERE name = ?').run(managerId, name);
  }

  remove(name: string): void {
    this.db.prepare('UPDATE projects SET removed_at = ? WHERE name = ? AND removed_at IS NULL').run(Date.now(), name);
  }

  /**
   * Copies in the config file's projects that were never copied before. A project's manager is the
   * latest manager session it already has, if any.
   */
  importFromConfig(projects: ProjectConfig[]): string[] {
    const meta = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(IMPORTED_KEY) as { value: string } | undefined;
    const done = new Set<string>(meta ? JSON.parse(meta.value) : []);
    const added: string[] = [];
    for (const p of projects) {
      if (done.has(p.name)) continue;
      done.add(p.name);
      if (this.db.prepare('SELECT 1 FROM projects WHERE name = ?').get(p.name)) continue;
      const manager = this.db
        .prepare(`SELECT id FROM sessions WHERE project = ? AND role = 'manager' ORDER BY created_at DESC LIMIT 1`)
        .get(p.name) as { id: string } | undefined;
      this.add(p, manager?.id ?? null);
      added.push(p.name);
    }
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(IMPORTED_KEY, JSON.stringify([...done]));
    return added;
  }
}

/** Colours a later version may not know read as none, rather than hiding the project. */
function readColours(json: string | null | undefined): ProjectColours {
  if (!json) return NO_COLOURS;
  try {
    return parseColours(JSON.parse(json));
  } catch {
    return NO_COLOURS;
  }
}
