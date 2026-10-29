// Runs Claude Code inside a project's running container through `docker exec -i`.
//
// Claude runs in its own process group (`setsid -w`), and the group's id goes into a pid file, so
// stopping ends everything the session started inside the container, not just the `docker exec`
// client (docs/steps/step-1a-spike.md, finding 3; the stopping itself is in src/host/stop.ts).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { DockerProjectConfig } from '../config.ts';
import type { LaunchSpec } from '../host/protocol.ts';
import { failureReason, ghApiAnswer, PLUGIN_FILES, sessionEnv, type Runner } from './runner.ts';
import { GIT_STATE, type GhAnswer, type GitState } from '../sessions/pr-poll.ts';
import { containerProblem, lockdownOf } from '../projects/lockdown.ts';
import { stopInContainer } from '../host/stop.ts';
import type { ShellSpawn } from './shell-run.ts';
import { shellFolder } from '../accounts/signin.ts';
import { SIGN_IN_ENV } from '../accounts/store.ts';
import { SKILL_HEAD_BYTES, type SkillFile } from '../sessions/skills.ts';

const run = promisify(execFile);

const SECRET_ENV = new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);

/**
 * An account's sign-in folder in the container (issue #342) is set inside it, not by `docker exec -e`: a folder
 * in the container user's home ("~/...") is only known there. The script part that sets it, and the
 * environment without it; none: the container's own login. Claude Code's other files stay the container user's.
 */
function loginFolderPart(env: Record<string, string>): { set: string; env: Record<string, string> } {
  const folder = env[SIGN_IN_ENV];
  if (folder === undefined || folder === process.env[SIGN_IN_ENV]) return { set: '', env };
  const rest = { ...env };
  delete rest[SIGN_IN_ENV];
  return { set: `${SIGN_IN_ENV}=${shellFolder(folder)}; export ${SIGN_IN_ENV}; `, env: rest };
}

/** The login folder a script in the container reads Claude Code's files from: the account's, or the container user's own. */
function configFolder(configDir: string | null): string {
  return configDir ? shellFolder(configDir) : '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
}

export class DockerRunner implements Runner {
  readonly kind = 'docker';
  readonly cwd: string;
  private readonly project: DockerProjectConfig;
  private readonly tag: string;
  /** Numbers the `!` commands, each with its own tag (issue #212). */
  private shells = 0;

  constructor(project: DockerProjectConfig, sessionId: string) {
    this.project = project;
    this.cwd = project.pathInContainer;
    this.tag = `ledung-${sessionId}`;
  }

  private exec(script: string, timeout?: number): Promise<{ stdout: string }> {
    const user = this.project.user ? ['-u', this.project.user] : [];
    return run('docker', ['exec', ...user, this.project.container, 'sh', '-c', script], { windowsHide: true, timeout });
  }

  async prepare(): Promise<void> {
    let running: string;
    try {
      running = (await run('docker', ['inspect', '-f', '{{.State.Running}}', this.project.container], { windowsHide: true })).stdout.trim();
    } catch {
      throw new Error(`The container "${this.project.container}" was not found. Is Docker Desktop running, and is the dev container started?`);
    }
    if (running !== 'true') throw new Error(`The container "${this.project.container}" is not running.`);
    // `docker exec -w` into a missing folder fails with exit code 127 and no useful message (finding 4).
    try {
      await this.exec(`test -d '${this.cwd.replace(/'/g, `'\\''`)}'`);
    } catch {
      throw new Error(`The folder ${this.cwd} does not exist in the container "${this.project.container}".`);
    }
    // Lockdown level B (issue #109): the container is the wall, so it is checked before every start.
    const lock = lockdownOf(this.project);
    if (lock.level === 'B') {
      const { stdout } = await run('docker', ['inspect', this.project.container], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      const problem = containerProblem(JSON.parse(stdout), { container: this.project.container, folder: this.cwd, network: lock.dockerNetwork ?? null });
      if (problem) throw new Error(problem);
    }
  }

  /** The Claude Code inside the container, as `claude --version` there says. */
  async claudeVersion(): Promise<string | null> {
    try {
      return (await this.exec('claude --version', 15000)).stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async currentBranch(): Promise<string | null> {
    try {
      const { stdout } = await this.exec(`git -C '${this.cwd.replace(/'/g, `'\\''`)}' rev-parse --abbrev-ref HEAD`);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** The container's own `gh` login, per container and user. */
  get ghScope(): string {
    return `docker:${this.project.container}${this.project.user ? `:${this.project.user}` : ''}`;
  }

  async gitState(): Promise<GitState | null> {
    const SEP = '--ledung-git--';
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    const git = (args: string[]) => `git -C ${q(this.cwd)} ${args.map(q).join(' ')} 2>/dev/null`;
    try {
      const { stdout } = await this.exec(`${git(['rev-parse', '--abbrev-ref', 'HEAD'])}; echo ${SEP}; ${git(GIT_STATE.config)}; echo ${SEP}; ${git(GIT_STATE.refs)}`, 10000);
      const [head = '', config = '', refs = ''] = stdout.split(`${SEP}\n`);
      return head.trim() ? { head, config, refs } : null;
    } catch {
      return null;
    }
  }

  ghApi(args: string[], input: string | null, timeoutMs: number): Promise<GhAnswer> {
    const user = this.project.user ? ['-u', this.project.user] : [];
    return ghApiAnswer('docker', ['exec', '-i', ...user, this.project.container, 'gh', 'api', ...args], input, timeoutMs);
  }

  /** In the given Claude Code folder in the container, else the container user's own. */
  async pluginSettingsTexts(configDir: string | null): Promise<string[]> {
    const SEP = '--ledung-file--';
    const cwd = this.cwd.replace(/'/g, `'\\''`);
    const files = [
      ...PLUGIN_FILES.config.map((f) => `${configFolder(configDir)}/${f}`),
      ...PLUGIN_FILES.project.map((f) => `'${cwd}/${f}'`),
    ];
    try {
      const { stdout } = await this.exec(files.map((f) => `cat ${f} 2>/dev/null; echo; echo ${SEP}`).join('; '));
      return stdout.split(SEP).map((t) => t.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** In the given Claude Code folder in the container, else the container user's own. */
  async skillFiles(configDir: string | null): Promise<SkillFile[]> {
    const SEP = '--ledung-skill--';
    const script = `D=${configFolder(configDir)}; for f in "$D"/skills/*/SKILL.md "$D"/skills/synced/*/*/SKILL.md; do [ -f "$f" ] || continue; echo "${SEP} \${f#$D/}"; head -c ${SKILL_HEAD_BYTES} "$f"; echo; done`;
    try {
      const { stdout } = await this.exec(script, 15000);
      return stdout.split(`${SEP} `).slice(1).map((chunk) => {
        const nl = chunk.indexOf('\n');
        return { path: chunk.slice(0, nl).trim(), text: chunk.slice(nl + 1) };
      });
    } catch {
      return [];
    }
  }

  async readProjectFile(relative: string): Promise<string | null> {
    const file = `${this.cwd.replace(/\/+$/, '')}/${relative}`.replace(/'/g, `'\\''`);
    try {
      return (await this.exec(`cat '${file}'`)).stdout;
    } catch {
      return null;
    }
  }

  async pullRequestView(pr: number, repo: string | null, fields: string, timeoutMs: number): Promise<{ json: string } | { error: string }> {
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
    try {
      const { stdout } = await this.exec(`cd ${q(this.cwd)} && gh pr view ${Number(pr)}${repo ? ` -R ${q(repo)}` : ''} --json ${q(fields)}`, timeoutMs);
      return { json: stdout };
    } catch (e) {
      return { error: failureReason(e, timeoutMs) };
    }
  }

  launchSpec(options: SpawnOptions): LaunchSpec {
    // Pass on only what the SDK added or changed; the rest of this machine's environment stays out.
    const env = sessionEnv(options);
    const login = loginFolderPart(env);
    // A key goes by name only: docker takes its value from its own environment (which the host passes
    // on), so it never appears on a command line (projects and accounts, P3).
    const envFlags = Object.entries(login.env)
      .filter(([k, v]) => process.env[k] !== v)
      .flatMap(([k, v]) => ['-e', SECRET_ENV.has(k) ? k : `${k}=${v}`]);
    const user = this.project.user ? ['-u', this.project.user] : [];
    const pidFile = `/tmp/${this.tag}.pid`;
    const args = [
      'exec', '-i', ...user, '-w', this.cwd, ...envFlags, '-e', `LEDUNG_TAG=${this.tag}`, this.project.container,
      'setsid', '-w', 'sh', '-c', `echo $$ > ${pidFile}; ${login.set}exec claude "$@"`, 'sh', ...options.args,
    ];
    return { command: 'docker', args, env, stop: { kind: 'docker', container: this.project.container, user: this.project.user, tag: this.tag } };
  }

  /**
   * A `!` command in the container, as the project's user, in its folder (issue #212): bash where the image
   * has it, else sh. Its own tag, so ending it ends what it started there and nothing of the session's.
   */
  shell(command: string, _kind: unknown, base: Record<string, string>): ShellSpawn & { shellName: string } {
    const env = sessionEnv({ env: base });
    const login = loginFolderPart(env);
    const tag = `${this.tag}-sh${++this.shells}-`;
    // The login goes by name only, as for Claude Code (launchSpec).
    const envFlags = Object.keys(env).filter((k) => SECRET_ENV.has(k)).flatMap((k) => ['-e', k]);
    const user = this.project.user ? ['-u', this.project.user] : [];
    const script = `echo $$ > /tmp/${tag}.pid; ${login.set}if command -v bash >/dev/null 2>&1; then exec bash -c "$1"; else exec sh -c "$1"; fi`;
    const args = ['exec', ...user, '-w', this.cwd, ...envFlags, '-e', `LEDUNG_TAG=${tag}`, this.project.container, 'sh', '-c', script, 'sh', command];
    const stop = { kind: 'docker' as const, container: this.project.container, user: this.project.user, tag };
    return { command: 'docker', args, env, shellName: `the container ${this.project.container}`, endInside: async () => void await stopInContainer(stop) };
  }
}
