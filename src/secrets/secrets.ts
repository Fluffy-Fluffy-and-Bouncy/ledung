// The secrets locked in the message box (issue #468): kept in the vault (src/secrets/vault.ts), per session or,
// until removed, per project; given to a session's commands through its runtime files (src/secrets/runtime.ts);
// and blanked wherever Ledung shows or stores text again. Values never leave this module except to a session's
// environment.
import crypto from 'node:crypto';
import { envName, MAX_SECRET_LENGTH, MIN_BLANKED_LENGTH, SECRET_LIFETIMES, secretNameProblem, type SecretInfo, type SecretLifetime } from '../shared/secrets.ts';
import type { SecretValue } from './runtime.ts';
import type { Vault } from './vault.ts';

export class SecretError extends Error {}

interface Entry {
  id: string;
  name: string;
  value: string;
  lifetime: SecretLifetime;
  /** The session it was locked in; a project secret is every session's of the project. */
  sessionId: string;
  project: string;
  createdAt: number;
  /** A "once" secret: when the message carrying it was sent; it goes when a turn that began after that ends. */
  sentAt?: number;
}

/** Where a secret applies: a session, and its project for the project's secrets. */
export interface SecretScope {
  sessionId: string;
  project: string;
}

export class Secrets {
  private entries: Entry[] = [];
  private readonly vault: Vault | null;
  /** Why secrets can't be used on this computer now (the vault couldn't be opened); null: they can. */
  problem: string | null = null;
  /** Told after every change, with the session or (for a project secret) the project it touches. */
  onChange: (change: { sessionId: string } | { project: string }) => void = () => {};
  /** The values to blank, longest first, so a value inside another is never blanked half; each as typed and as JSON escapes it. */
  private blanks: { forms: string[]; mark: string }[] = [];

  private constructor(vault: Vault | null) {
    this.vault = vault;
  }

  /** Reads the vault; one that can't be read leaves secrets unavailable, with the reason, and is never overwritten. */
  static async open(vault: Vault | null, log: (line: string) => void = () => {}): Promise<Secrets> {
    const s = new Secrets(vault);
    if (!vault) return s;
    try {
      s.entries = (await vault.read<Entry>()).filter((e) => e && typeof e.value === 'string' && SECRET_LIFETIMES.includes(e.lifetime));
      s.reblank();
      if (s.entries.length) log(`Secrets: ${s.entries.length} locked secret(s), kept with ${vault.kind}.`);
    } catch (e) {
      s.problem = `Locked secrets are unavailable: ${(e as Error).message}.`;
      log(`Secrets: ${s.problem}`);
    }
    return s;
  }

  /** In memory only: for tests. */
  static memory(): Secrets {
    return new Secrets(null);
  }

  private visible(scope: SecretScope): Entry[] {
    return this.entries.filter((e) => e.sessionId === scope.sessionId || (e.lifetime === 'project' && e.project === scope.project));
  }

  private info(e: Entry, reachesNow: boolean): SecretInfo {
    return { id: e.id, name: e.name, env: envName(e.name), lifetime: e.lifetime, createdAt: e.createdAt, reachesNow };
  }

  /** The secrets a session may use: its own and its project's, oldest first. */
  list(scope: SecretScope, reachesNow = false): SecretInfo[] {
    return this.visible(scope).map((e) => this.info(e, reachesNow));
  }

  /** The names a session may use, for expanding its messages. */
  names(scope: SecretScope): Set<string> {
    return new Set(this.visible(scope).map((e) => e.name));
  }

  /** The values for a session's commands, by variable. */
  values(scope: SecretScope): SecretValue[] {
    return this.visible(scope).map((e) => ({ env: envName(e.name), value: e.value }));
  }

  /** The values for a launch environment: not the "once" ones, which a process that outlives their turn would keep. */
  launchValues(scope: SecretScope): SecretValue[] {
    return this.visible(scope).filter((e) => e.lifetime !== 'once').map((e) => ({ env: envName(e.name), value: e.value }));
  }

  private find(scope: SecretScope, id: string): Entry {
    const e = this.visible(scope).find((x) => x.id === id);
    if (!e) throw new SecretError('No such secret in this session.');
    return e;
  }

  private checkName(scope: SecretScope, name: string, except: string | null, lifetime: SecretLifetime): void {
    const problem = secretNameProblem(name);
    if (problem) throw new SecretError(problem);
    // Two names can share a variable (a-b and a_b): the variable has to be unique too. A project secret reaches
    // every session of the project, so it must clash with none of theirs (review of #468, finding 4).
    const pool = lifetime === 'project' ? this.entries.filter((e) => e.project === scope.project) : this.visible(scope);
    if (pool.some((e) => e.id !== except && envName(e.name) === envName(name))) {
      throw new SecretError(`${lifetime === 'project' ? 'A session of this project' : 'This session'} already has a secret named "${name}" (or another for $${envName(name)}).`);
    }
  }

  private usable(): void {
    if (this.problem) throw new SecretError(this.problem);
  }

  async add(scope: SecretScope, name: string, value: string, lifetime: SecretLifetime): Promise<SecretInfo> {
    this.usable();
    if (!SECRET_LIFETIMES.includes(lifetime)) throw new SecretError('Say how long it lasts: once, session, kept or project.');
    if (!value) throw new SecretError('There is no value to lock.');
    if (value.length > MAX_SECRET_LENGTH) throw new SecretError(`A secret is at most ${MAX_SECRET_LENGTH} characters.`);
    if (value.includes('\0')) throw new SecretError('A secret can\'t contain a NUL character.');
    this.checkName(scope, name, null, lifetime);
    const e: Entry = { id: crypto.randomUUID(), name, value, lifetime, sessionId: scope.sessionId, project: scope.project, createdAt: Date.now() };
    await this.commit([...this.entries, e], [e]);
    return this.info(e, false);
  }

  async edit(scope: SecretScope, id: string, edit: { name?: string; lifetime?: SecretLifetime }): Promise<SecretInfo> {
    this.usable();
    const e = this.find(scope, id);
    if (edit.lifetime !== undefined && !SECRET_LIFETIMES.includes(edit.lifetime)) throw new SecretError('Say how long it lasts: once, session, kept or project.');
    const next: Entry = { ...e, name: edit.name ?? e.name, lifetime: edit.lifetime ?? e.lifetime };
    if (next.name !== e.name || (next.lifetime === 'project' && e.lifetime !== 'project')) this.checkName(scope, next.name, e.id, next.lifetime);
    // A project secret made the session's again is the session's it is shown in.
    if (e.lifetime === 'project' && next.lifetime !== 'project') next.sessionId = scope.sessionId;
    await this.commit(this.entries.map((x) => (x === e ? next : x)), [e, next]);
    return this.info(next, false);
  }

  async remove(scope: SecretScope, id: string): Promise<void> {
    const e = this.find(scope, id);
    await this.drop((x) => x === e);
  }

  /** A message carrying these "once" secrets was sent now; kept in the vault, so a restart keeps the rule. */
  async markSent(sessionId: string, names: readonly string[], at = Date.now()): Promise<void> {
    const which = (e: Entry) => e.sessionId === sessionId && e.lifetime === 'once' && e.sentAt === undefined && names.includes(e.name);
    if (!this.entries.some(which)) return;
    await this.commit(this.entries.map((e) => (which(e) ? { ...e, sentAt: at } : e)), []);
  }

  /**
   * A turn of the session that began at `turnBegan` ended: the "once" secrets sent before it began had their turn.
   * One sent during it stays for the next turn, which is the one that answers it (review of #468, finding 7).
   */
  async turnEnded(sessionId: string, turnBegan: number): Promise<void> {
    await this.drop((e) => e.sessionId === sessionId && e.lifetime === 'once' && e.sentAt !== undefined && e.sentAt <= turnBegan);
  }

  /** The session's Claude Code ended: its "once" secrets that were sent go; one still in the message box stays. */
  async sessionStopped(sessionId: string): Promise<void> {
    await this.drop((e) => e.sessionId === sessionId && e.lifetime === 'once' && e.sentAt !== undefined);
  }

  /** A session that ended for good (archived): its own secrets but those kept until removed. */
  async endSession(sessionId: string): Promise<void> {
    await this.drop((e) => e.sessionId === sessionId && (e.lifetime === 'once' || e.lifetime === 'session'));
  }

  /** At Ledung's start: the sent "once" secrets of sessions no longer running had their turn. */
  async dropOnceExcept(live: ReadonlySet<string>): Promise<void> {
    await this.drop((e) => e.lifetime === 'once' && e.sentAt !== undefined && !live.has(e.sessionId));
  }

  /** A removed project takes its project secrets along. */
  async dropProject(project: string): Promise<void> {
    await this.drop((e) => e.project === project);
  }

  private async drop(which: (e: Entry) => boolean): Promise<void> {
    const gone = this.entries.filter(which);
    if (!gone.length) return;
    await this.commit(this.entries.filter((e) => !which(e)), gone);
  }

  /**
   * The new entries, in the vault first: a write that fails changes nothing, so a refused lock can be tried
   * again and nothing in use is lost at the next start (review of #468, finding 6).
   */
  private async commit(next: Entry[], touched: Entry[]): Promise<void> {
    if (this.vault) await this.vault.write(next);
    this.entries = next;
    this.reblank();
    const told = new Set<string>();
    for (const e of touched) {
      const key = e.lifetime === 'project' ? `p:${e.project}` : `s:${e.sessionId}`;
      if (told.has(key)) continue;
      told.add(key);
      this.onChange(e.lifetime === 'project' ? { project: e.project } : { sessionId: e.sessionId });
    }
  }

  private reblank(): void {
    const seen = new Set<string>();
    this.blanks = this.entries
      .filter((e) => e.value.length >= MIN_BLANKED_LENGTH && !seen.has(e.value) && seen.add(e.value))
      .sort((a, b) => b.value.length - a.value.length)
      .map((e) => ({ forms: [...new Set([e.value, JSON.stringify(e.value).slice(1, -1)])], mark: `🔑${e.name}` }));
  }

  /** Text with every secret's exact value replaced by 🔑name, also as it reads inside JSON in the text. */
  blank(text: string): string {
    let out = text;
    for (const b of this.blanks) for (const f of b.forms) if (out.includes(f)) out = out.split(f).join(b.mark);
    return out;
  }

  /**
   * The same for data about to be stored as JSON: only its strings are blanked, never its structure, so a value
   * that is also a number, a key or `true` can't break or change the record (review of #468, finding 1).
   */
  blankDeep<T>(data: T): T {
    if (!this.blanks.length) return data;
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') return this.blank(v);
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(data) as T;
  }

  /** Whether a text holds any secret's value (a board attachment is refused for it). */
  holdsValue(text: string): boolean {
    return this.blanks.some((b) => b.forms.some((f) => text.includes(f)));
  }
}
