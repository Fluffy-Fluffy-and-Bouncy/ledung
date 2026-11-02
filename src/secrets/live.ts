// One session's side of the locked secrets (issue #468): what its Claude Code gets at launch, keeping its
// runtime files current while it runs, its messages as Claude reads them, and the clean-up when it ends.
import fs from 'node:fs';
import { expandSecrets, expandSecretsForShell, tokenNames, type SecretInfo } from '../shared/secrets.ts';
import type { LaunchSecrets } from '../runners/runner.ts';
import { cleanContainer, DockerSecretRuntime, localRuntimeSessions, LocalSecretRuntime, type SecretRuntime } from './runtime.ts';
import type { Secrets, SecretScope } from './secrets.ts';

/** Where a running session's runtime files are, kept across Ledung's restarts so its next start can remove them. */
export type RuntimePlace = { kind: 'local'; dir: string } | { kind: 'docker'; container: string; user?: string };

/** The record of running sessions' runtime places: one meta entry, so a crash leaves nothing it can't find. */
export interface PlaceBook {
  get(sessionId: string): RuntimePlace | null;
  set(sessionId: string, place: RuntimePlace | null): void;
  all(): Map<string, RuntimePlace>;
}

export function metaPlaceBook(meta: { get: (k: string) => string | null; set: (k: string, v: string) => void }): PlaceBook {
  const KEY = 'secrets-runtime';
  const read = (): Record<string, RuntimePlace> => {
    try {
      return JSON.parse(meta.get(KEY) ?? '{}') as Record<string, RuntimePlace>;
    } catch {
      return {};
    }
  };
  return {
    get: (id) => read()[id] ?? null,
    set: (id, place) => {
      const all = read();
      if (place) all[id] = place;
      else delete all[id];
      meta.set(KEY, JSON.stringify(all));
    },
    all: () => new Map(Object.entries(read())),
  };
}

function runtimeAt(place: RuntimePlace, sessionId: string): SecretRuntime {
  return place.kind === 'local' ? new LocalSecretRuntime(place.dir, sessionId) : new DockerSecretRuntime(place, sessionId);
}

export class SessionSecrets {
  readonly scope: SecretScope;
  private readonly secrets: Secrets;
  private readonly runtime: SecretRuntime;
  private readonly book: PlaceBook;
  private readonly log: (line: string) => void;
  /** This session's Claude Code sources the env file: started by a Ledung with #468 (false: from its next start). */
  private reach = false;

  constructor(o: { secrets: Secrets; scope: SecretScope; runtime: SecretRuntime; book: PlaceBook; log?: (line: string) => void }) {
    this.secrets = o.secrets;
    this.scope = o.scope;
    this.runtime = o.runtime;
    this.book = o.book;
    this.log = o.log ?? ((line) => console.error(line));
  }

  private place(): RuntimePlace {
    const r = this.runtime;
    if (r instanceof LocalSecretRuntime) return { kind: 'local', dir: r.folder };
    return { kind: 'docker', ...(r as DockerSecretRuntime).target };
  }

  /**
   * At a launch (start or resume, not a reattach): the env file and the current values written, and what Claude
   * Code's environment gets. Null when they couldn't be written: the session starts without its secrets.
   * `tempFolder`: a level B session's own temp folder, which its sandboxed shell can read.
   */
  async launch(tempFolder: string | null): Promise<{ env: Record<string, string>; secrets: LaunchSecrets } | null> {
    this.reach = false;
    try {
      if (tempFolder && this.runtime instanceof LocalSecretRuntime) this.runtime.moveTo(tempFolder);
      const values = this.secrets.values(this.scope);
      const names = values.map((v) => v.env);
      const script = this.runtime.envScript(names);
      this.book.set(this.scope.sessionId, this.place());
      this.runtime.prepare(script);
      await this.runtime.write(values);
      this.reach = true;
      // In the launch environment too, for what doesn't source the env file (the PowerShell tool, MCP servers).
      const env = { ...Object.fromEntries(values.map((v) => [v.env, v.value])), CLAUDE_ENV_FILE: this.runtime.envFile };
      return { env, secrets: { names, envFile: this.runtime.envFile, script } };
    } catch (e) {
      this.log(`Secrets for session ${this.scope.sessionId}: could not write its files: ${(e as Error).message}`);
      return null;
    }
  }

  /** Reattached after Ledung's restart: it sources the env file if a Ledung with #468 launched it. */
  attached(): void {
    this.reach = this.book.get(this.scope.sessionId) !== null;
  }

  /** The secrets changed: the values file follows, so the next command has them. */
  async refresh(): Promise<void> {
    if (!this.reach) return;
    try {
      await this.runtime.write(this.secrets.values(this.scope));
    } catch (e) {
      this.log(`Secrets for session ${this.scope.sessionId}: could not update its file: ${(e as Error).message}`);
    }
  }

  /** Its Claude Code ended: the plain-text files go, and so do its "once" secrets. */
  async ended(): Promise<void> {
    this.reach = false;
    await this.runtime.clear();
    this.book.set(this.scope.sessionId, null);
    const once = new Set(this.secrets.list(this.scope).filter((s) => s.lifetime === 'once').map((s) => s.name));
    if (once.size) await this.secrets.removeOnce(this.scope.sessionId, once);
  }

  list(live: boolean): SecretInfo[] {
    return this.secrets.list(this.scope, live && this.reach);
  }

  /** Values for a "!" command's environment, and the variables that hold them. */
  env(): Record<string, string> {
    return Object.fromEntries(this.secrets.values(this.scope).map((v) => [v.env, v.value]));
  }

  /**
   * A message as Claude reads it: each token of this session's secrets named for Claude, and any value typed
   * as it is blanked. `once`: the "once" secrets it carries, which go after the turn it starts.
   */
  forClaude(text: string): { text: string; once: string[] } {
    const known = this.secrets.names(this.scope);
    const { text: out, used } = expandSecrets(this.secrets.blank(text), known);
    const onceNames = new Set(this.secrets.list(this.scope).filter((s) => s.lifetime === 'once').map((s) => s.name));
    return { text: out, once: used.filter((n) => onceNames.has(n)) };
  }

  /** A "!" command with its tokens as references to their variables. */
  shellCommand(command: string, powershell: boolean): string {
    return expandSecretsForShell(command, this.secrets.names(this.scope), powershell);
  }

  /** The tokens in a text that name none of this session's secrets. */
  unknownTokens(text: string): string[] {
    const known = this.secrets.names(this.scope);
    return tokenNames(text).filter((n) => !known.has(n));
  }

  /** Text with every locked secret's value as 🔑name. */
  blank(text: string): string {
    return this.secrets.blank(text);
  }

  removeOnce(names: ReadonlySet<string>): Promise<void> {
    return this.secrets.removeOnce(this.scope.sessionId, names);
  }
}

/**
 * At Ledung's start: every runtime file of a session that is no longer running goes (the manager's addition 1
 * on question #1565), in the places the book recorded, in the local folder, and in the containers named.
 */
export async function cleanStaleRuntime(o: {
  book: PlaceBook; live: ReadonlySet<string>; localDir: string; containers: { container: string; user?: string }[]; log: (line: string) => void;
}): Promise<void> {
  let removed = 0;
  for (const [id, place] of o.book.all()) {
    if (o.live.has(id)) continue;
    try {
      await runtimeAt(place, id).clear();
      o.book.set(id, null);
      removed++;
    } catch {
      // A container that isn't running: tried again on the next start.
    }
  }
  for (const [id, files] of localRuntimeSessions(o.localDir)) {
    if (o.live.has(id)) continue;
    await runtimeAt({ kind: 'local', dir: o.localDir }, id).clear();
    for (const f of files) fs.rmSync(f, { force: true });
    removed++;
  }
  for (const target of o.containers) {
    try {
      removed += await cleanContainer(target, o.live);
    } catch {
      // Not running, or no docker: nothing of it can be reached now.
    }
  }
  if (removed) o.log(`Secrets: removed the runtime files of ${removed} session(s) no longer running.`);
}

