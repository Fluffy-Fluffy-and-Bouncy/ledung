// Claude accounts (projects and accounts, P3). A project uses one account; its manager and sessions get
// that account's sign-in folder in their environment, and nothing else changes: an account is only the
// sign-in (Martin, 2026-10-27, on #342: "if we change account on a worker, I dont want to see a difference
// except the account token limits and the Account name"). Claude Code keeps its sign-in apart from its other
// files when CLAUDE_SECURESTORAGE_CONFIG_DIR is set (#342, probe of 2026-10-27: one shared CLAUDE_CONFIG_DIR,
// two sign-in folders, two plans), so conversations, memory, skills and settings stay in the one Claude Code
// folder every session shares, whatever its account. Internal to Claude Code, not documented: the SDK sets it
// itself, and test/accounts.test.ts checks it against the real Claude Code.
//
// Ledung never stores, reads or passes a sign-in token (issue #342, from Anthropic's terms quoted on #339): the
// user signs in to the folder with Claude Code's own /login. Each account has a sign-in folder on this computer
// and one in each container its projects run in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { userDataDir } from '../platform/paths.ts';
import type { AccountInfoView } from '../shared/protocol.ts';
import type { ClaudeAccountConfig } from '../config.ts';
import { writeAboutFile } from './about-file.ts';

export const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
/** What usage and limits are recorded under for a project without an account. */
export const DEFAULT_ACCOUNT = 'default';

export class AccountError extends Error {}

/** The setting that points Claude Code's sign-in, and only its sign-in, at a folder (#342). */
export const SIGN_IN_ENV = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

/** Where a session of the account runs: this computer, or a container (where the login folder is the container's). */
export type AccountPlace = 'local' | 'docker';

/** An account's login folder in containers when none is given: in the container user's home. */
export function defaultContainerDir(name: string): string {
  return `~/.ledung-accounts/${name}`;
}

/**
 * A login folder as Ledung keeps it, once: absolute, without a trailing separator. On macOS the Keychain
 * entry is named from the path exactly as written, so "dir" and "dir/" are two logins (#342, Mac probe).
 */
export function canonicalFolder(folder: string): string {
  return path.resolve(folder);
}

/** A container folder as kept: "~/..." or an absolute path, without a trailing "/"; null when not one. */
export function canonicalContainerFolder(folder: string): string | null {
  const f = folder.trim().replace(/\/+$/, '');
  // Letters, digits and . _ / + - only: the folder goes unquoted into the sign-in command the page shows,
  // inside sh -c '…', so nothing in it may mean anything to a shell (review of #342, M1).
  if (!/^(~\/|\/)[A-Za-z0-9._/+-]*$/.test(f) || f.split('/').includes('..') || f === '~' || f === '/') return null;
  return f;
}

/** Two folders on this computer are the same login folder (Windows and macOS ignore case). */
export function sameFolder(a: string, b: string, platform = process.platform): boolean {
  const x = canonicalFolder(a);
  const y = canonicalFolder(b);
  return platform === 'win32' || platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * The login folders on this computer an account may not use: Claude Code's default folder and Ledung's own,
 * whose sign-in is the computer's, so signing the account out would sign them out (review of #342, I3).
 */
export function sharedLoginFolders(): string[] {
  return [path.join(os.homedir(), '.claude'), ...(process.env.CLAUDE_CONFIG_DIR ? [process.env.CLAUDE_CONFIG_DIR] : [])];
}

/** In a container: the container user's own login folder, which an account may not use either. */
const SHARED_CONTAINER_FOLDERS = ['~/.claude'];

export class AccountStore {
  private readonly db: DatabaseSync;
  /** Ledung's own accounts folder: the default login folders. */
  readonly dir: string;

  constructor(db: DatabaseSync, dir = path.join(userDataDir(), 'accounts')) {
    this.db = db;
    this.dir = dir;
  }

  list(): AccountInfoView[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY name').all() as Record<string, any>[]).map((r) => toView(r));
  }

  get(name: string): AccountInfoView | undefined {
    const r = this.db.prepare('SELECT * FROM accounts WHERE name = ?').get(name) as Record<string, any> | undefined;
    return r ? toView(r) : undefined;
  }

  /** The default login folder on this computer for an account of this name. */
  defaultFolder(name: string): string {
    return canonicalFolder(path.join(this.dir, name));
  }

  /** Adds an account: its login folder is made, empty until someone signs in to it. */
  add(a: { name: string; kind?: 'folder'; configDir?: string; containerDir?: string }, whatItIsFor?: string | null): AccountInfoView {
    const name = a.name.trim();
    if (!ACCOUNT_NAME.test(name) || name === DEFAULT_ACCOUNT) {
      throw new AccountError('Use a short name of letters, digits, "_" or "-" (not "default").');
    }
    if (this.get(name)) throw new AccountError(`There is already an account named "${name}".`);
    let containerDir: string | null = null;
    if (a.containerDir?.trim()) {
      containerDir = canonicalContainerFolder(a.containerDir);
      if (!containerDir) throw new AccountError('The folder in containers is a path starting with "/" or "~/", of letters, digits and . _ / + - only.');
    }
    const configDir = a.configDir?.trim() ? canonicalFolder(a.configDir.trim()) : this.defaultFolder(name);
    // Each account's folders are its own: one shared with another login would be signed out with it (review of #342, I3).
    const taken = this.sharedWith({ name, configDir, containerDir: containerDir ?? defaultContainerDir(name) });
    if (taken) throw new AccountError(`That login folder is already ${taken}; an account needs a folder of its own.`);
    makeFolder(configDir);
    this.db.prepare('INSERT INTO accounts (name, kind, config_dir, container_dir, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, 'folder', configDir, containerDir, Date.now());
    this.writeAbout(name, whatItIsFor);
    return this.get(name)!;
  }

  /**
   * Whose login a folder of this account would share, in words, or null when it is its own: the computer's
   * default, Ledung's own, or another account's (on this computer, or an absolute folder in containers).
   */
  sharedWith(a: { name: string; configDir?: string; containerDir?: string }): string | null {
    if (a.configDir !== undefined) {
      if (sharedLoginFolders().some((f) => sameFolder(f, a.configDir!))) return "this computer's own Claude Code login folder";
      const other = this.list().find((o) => o.name !== a.name && sameFolder(o.configDir, a.configDir!));
      if (other) return `the login folder of the account "${other.name}"`;
    }
    if (a.containerDir !== undefined) {
      if (SHARED_CONTAINER_FOLDERS.includes(a.containerDir)) return "the container user's own Claude Code login folder";
      const other = this.list().find((o) => o.name !== a.name && this.folderFor(o, 'docker') === a.containerDir);
      if (other) return `the login folder in containers of the account "${other.name}"`;
    }
    return null;
  }

  /** The containers (and users) the account's projects have run in, so removing it signs out there too (review of #342, I2). */
  containersOf(name: string): { container: string; user?: string }[] {
    const r = this.db.prepare('SELECT containers FROM accounts WHERE name = ?').get(name) as { containers: string | null } | undefined;
    try {
      return r?.containers ? JSON.parse(r.containers) : [];
    } catch {
      return [];
    }
  }

  /** Notes a container the account's sessions run in; once each. */
  noteContainer(name: string, place: { container: string; user?: string }): void {
    const known = this.containersOf(name);
    if (known.some((c) => c.container === place.container && (c.user ?? '') === (place.user ?? ''))) return;
    const entry = { container: place.container, ...(place.user ? { user: place.user } : {}) };
    this.db.prepare('UPDATE accounts SET containers = ? WHERE name = ?').run(JSON.stringify([...known, entry]), name);
  }

  /**
   * The config file's "claudeAccounts" block (issue #425), at start and when it changes: an account Ledung doesn't
   * have is added, as Add account in the page does; one it has gets the folders the block gives, after the same
   * checks. A folder the block leaves out is left as it is, and an account not in the block stays: removing is the
   * page's, because it signs the account out. What can't be done is a problem in words, and the rest still goes on.
   */
  fromConfig(accounts: Record<string, ClaudeAccountConfig>): { added: string[]; changed: string[]; problems: string[] } {
    const added: string[] = [];
    const changed: string[] = [];
    const problems: string[] = [];
    for (const [name, entry] of Object.entries(accounts)) {
      try {
        const existing = this.get(name);
        if (!existing) {
          this.add({ name, configDir: entry.signInFolderOnThisComputer, containerDir: entry.signInFolderInContainers }, entry.whatItIsFor);
          added.push(name);
          continue;
        }
        const configDir = entry.signInFolderOnThisComputer ? canonicalFolder(entry.signInFolderOnThisComputer) : existing.configDir;
        const containerDir = entry.signInFolderInContainers ? canonicalContainerFolder(entry.signInFolderInContainers) : existing.containerDir;
        const newLocal = !sameFolder(configDir, existing.configDir);
        const newContainer = (containerDir ?? defaultContainerDir(name)) !== this.folderFor(existing, 'docker');
        if (newLocal || newContainer) {
          const taken = this.sharedWith({ name, ...(newLocal ? { configDir } : {}), ...(newContainer ? { containerDir: containerDir ?? defaultContainerDir(name) } : {}) });
          if (taken) throw new AccountError(`that folder is already ${taken}; an account needs a folder of its own.`);
          if (newLocal) makeFolder(configDir);
          // A new folder is a new sign-in: the old one stays where it was, and the banner asks for /login here.
          this.db.prepare('UPDATE accounts SET config_dir = ?, container_dir = ? WHERE name = ?').run(newLocal ? configDir : existing.configDir, containerDir, name);
          changed.push(name);
        }
        this.writeAbout(name, entry.whatItIsFor);
      } catch (e) {
        if (!(e instanceof AccountError)) throw e;
        problems.push(`The account "${name}" in the config file: ${e.message.charAt(0).toLowerCase()}${e.message.slice(1)}`);
      }
    }
    return { added, changed, problems };
  }

  /** Writes the note in the account's sign-in folder on this computer, if the folder is there (issue #425). */
  writeAbout(name: string, whatItIsFor?: string | null): boolean {
    const a = this.get(name);
    return !!a && writeAboutFile({ name, configDir: a.configDir, containerDir: this.folderFor(a, 'docker'), whatItIsFor });
  }

  /** Forgets the account. Its folders stay: they are the user's, with their own Claude Code settings and history. */
  remove(name: string): void {
    this.db.prepare('DELETE FROM accounts WHERE name = ?').run(name);
  }

  /** Who a session found itself logged in as (from Claude Code), shown so you can check. */
  setIdentity(name: string, who: { email?: string; organization?: string; subscriptionType?: string }): void {
    this.db.prepare('UPDATE accounts SET email = ?, organization = ?, plan = ?, seen_at = ? WHERE name = ?')
      .run(who.email ?? null, who.organization ?? null, who.subscriptionType ?? null, Date.now(), name);
  }

  /** The account's sign-in folder where its session runs: on this computer, or in a container ("~/" is the container user's home). */
  folderFor(account: AccountInfoView, place: AccountPlace): string {
    return place === 'local' ? account.configDir : account.containerDir ?? defaultContainerDir(account.name);
  }

  /**
   * The environment a session of this account gets: its sign-in folder, nothing else; Claude Code's other
   * files stay where every session has them. Throws if the account is gone, so a session never quietly runs
   * under the computer's own login instead.
   */
  envFor(name: string | null | undefined, place: AccountPlace = 'local'): Record<string, string> {
    if (!name) return {};
    const account = this.get(name);
    if (!account) throw new AccountError(`The account "${name}" doesn't exist any more. Choose another in the project's settings.`);
    return { [SIGN_IN_ENV]: this.folderFor(account, place) };
  }
}

/**
 * Makes an account's sign-in folder. One that can't be made (a missing drive, a file in the way, no permission) is an
 * AccountError, so a folder named in the config file is a problem line and never an uncaught error that stops
 * Ledung on a live edit (review of #425, C1).
 */
function makeFolder(folder: string): void {
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (e) {
    throw new AccountError(`its sign-in folder ${folder} can't be made (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`);
  }
}

function toView(r: Record<string, any>): AccountInfoView {
  return {
    name: r.name, kind: 'folder', configDir: r.config_dir, containerDir: r.container_dir ?? null,
    email: r.email ?? null, organization: r.organization ?? null, plan: r.plan ?? null,
    seenAt: r.seen_at == null ? null : Number(r.seen_at), createdAt: Number(r.created_at),
  };
}
