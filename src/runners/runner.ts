// A runner decides how a session's Claude Code process is started and stopped for a project.
// The session host does the starting and stopping (src/host/); the runner only describes it.
// Everything else in Ledung is the same whichever runner a session uses.
import { execFile } from 'node:child_process';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { LaunchSpec } from '../host/protocol.ts';
import type { GhAnswer, GitState } from '../sessions/pr-poll.ts';
import type { ShellKind, ShellSpawn } from './shell-run.ts';
import type { SkillFile } from '../sessions/skills.ts';
import type { ClaudeChoice } from './claude-program.ts';

export interface Runner {
  readonly kind: 'local' | 'docker';
  /** The working directory Claude Code sees: the project folder, or the session's own folder. */
  readonly cwd: string;
  /** Checks that the project can be started (folder exists, container running). Throws a readable error if not. */
  prepare(): Promise<void>;
  /** The version of the Claude Code this runner starts, or null when it can't be found (lockdown level B, issue #109). */
  claudeVersion(): Promise<string | null>;
  /**
   * The Claude Code program on this computer a session started now runs, and why when it isn't the one the
   * config asks for (issue #341). Left out by a runner that names no program: a container runs its own `claude`.
   */
  claudeProgram?(): Promise<ClaudeChoice>;
  /** Turns what the Agent SDK would start into what the host should start, and how to stop it. */
  launchSpec(options: SpawnOptions): LaunchSpec;
  /** The git branch of the session's folder, or null if it isn't a repository (step 5). */
  currentBranch(): Promise<string | null>;
  /**
   * Whose `gh` login the GitHub calls below use: sessions with the same scope share one batched pull request
   * query and one budget (issue #252). "local" for this computer; a container's own otherwise.
   */
  readonly ghScope: string;
  /** What git knows locally about the branch and its remote, for the pull request poll (issue #252); null: not a repository. Free: no GitHub call. */
  gitState(): Promise<GitState | null>;
  /** `gh api <args>` where the session runs, with `input` on its standard input. Never throws. */
  ghApi(args: string[], input: string | null, timeoutMs: number): Promise<GhAnswer>;
  /**
   * The Claude Code files that name plugins, as Claude Code in this session sees them: the user's
   * settings and installed plugins (in configDir, the account's login folder, when given) and the
   * project's settings. Missing files are left out. For session profiles (#20).
   */
  pluginSettingsTexts(configDir: string | null): Promise<string[]>;
  /**
   * The user's own skills' SKILL.md files in Claude Code's config folder (configDir, the account's login
   * folder, when given), as Claude Code in this session sees them: each one's start. For the skill picker (#300).
   */
  skillFiles(configDir: string | null): Promise<SkillFile[]>;
  /** A file inside the project folder (a relative path with "/"), as Claude Code there sees it; null when missing. */
  readProjectFile(relative: string): Promise<string | null>;
  /**
   * `gh pr view <pr> [-R repo] --json <fields>` where the session runs, for away mode's floors (issue #35):
   * its output, or why there is none. Never throws.
   */
  pullRequestView(pr: number, repo: string | null, fields: string, timeoutMs: number): Promise<{ json: string } | { error: string }>;
  /**
   * How to run a person's `!` command in the session's folder (issue #212): `kind` is the shell on Windows,
   * `env` the session's environment (sessionEnv's rules, with the project's login). Throws a readable error.
   */
  shell(command: string, kind: ShellKind, env: Record<string, string>): ShellSpawn & { shellName: string };
}

/** A failed command's reason in a few words, for away mode's record. */
export function failureReason(e: unknown, timeoutMs: number): string {
  const err = e as { killed?: boolean; signal?: string; code?: unknown; stderr?: string; message?: string };
  if (err.killed || err.signal === 'SIGTERM') return `gh did not answer within ${Math.round(timeoutMs / 1000)} s`;
  if (err.code === 'ENOENT') return 'gh is not installed where the session runs';
  const text = (err.stderr || err.message || 'gh failed').trim().split(/\r?\n/)[0] ?? 'gh failed';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** Where plugins are named, relative to Claude Code's config folder and to the project folder. */
export const PLUGIN_FILES = { config: ['settings.json', 'plugins/installed_plugins.json'], project: ['.claude/settings.json', '.claude/settings.local.json'] };

/** The environment for Claude Code: what the SDK passes, without Ledung's own LEDUNG_* settings, so
 *  a Ledung started from inside a session doesn't silently use this Ledung's config or data. */
export function sessionEnv(options: Pick<SpawnOptions, 'env'>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(options.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith('LEDUNG_')),
  );
}

/** Runs a command with `input` on its standard input; rejects like execFile, with what it printed on `stdout`. */
export function runWithInput(command: string, args: string[], input: string | null, timeoutMs: number): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
      else resolve({ stdout: String(stdout) });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

/** `gh api` through runWithInput, as a GhAnswer: a failure keeps what gh printed, since a GraphQL error still prints the body. */
export async function ghApiAnswer(command: string, args: string[], input: string | null, timeoutMs: number): Promise<GhAnswer> {
  try {
    return { ok: true, stdout: (await runWithInput(command, args, input, timeoutMs)).stdout };
  } catch (e) {
    return { ok: false, stdout: String((e as { stdout?: unknown }).stdout ?? ''), error: failureReason(e, timeoutMs) };
  }
}
