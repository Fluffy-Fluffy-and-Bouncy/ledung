// Runs Claude Code directly in a project folder on this machine.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { LocalProjectConfig } from '../config.ts';
import { chooseClaude, type ClaudeChoice, type ClaudeSetting } from './claude-program.ts';
import type { LaunchSpec } from '../host/protocol.ts';
import { failureReason, ghApiAnswer, PLUGIN_FILES, sessionEnv, type Runner } from './runner.ts';
import { GIT_STATE, type GhAnswer, type GitState } from '../sessions/pr-poll.ts';
import { localShell, type ShellKind, type ShellSpawn } from './shell-run.ts';
import { SKILL_HEAD_BYTES, type SkillFile } from '../sessions/skills.ts';

/** The first bytes of a file as text; null when it can't be read. */
async function readStart(file: string, bytes: number): Promise<string | null> {
  try {
    const h = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const { bytesRead } = await h.read(buf, 0, bytes, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await h.close();
    }
  } catch {
    return null;
  }
}

export class LocalRunner implements Runner {
  readonly kind = 'local';
  readonly cwd: string;

  private readonly claude: ClaudeSetting;

  /**
   * workDir: the session's own folder (start_session's cwd), already checked; none: the project folder.
   * claude: the config's "claudeExecutable" (issue #341), which Ledung always passes. The default, the SDK's own copy,
   * is for tests that make a runner on a computer that may have no Claude Code installed (CI's).
   */
  constructor(project: LocalProjectConfig, workDir?: string | null, claude: ClaudeSetting = 'bundled') {
    this.cwd = workDir ?? project.path;
    this.claude = claude;
  }

  async prepare(): Promise<void> {
    if (!fs.existsSync(this.cwd) || !fs.statSync(this.cwd).isDirectory()) {
      throw new Error(`The folder ${this.cwd} does not exist.`);
    }
  }

  /** The version `--version` of the program a session starts reports. */
  async claudeVersion(): Promise<string | null> {
    return (await this.claudeProgram()).program?.version ?? null;
  }

  claudeProgram(): Promise<ClaudeChoice> {
    return chooseClaude(this.claude);
  }

  async currentBranch(): Promise<string | null> {
    try {
      const { stdout } = await promisify(execFile)('git', ['-C', this.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { windowsHide: true, timeout: 5000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  readonly ghScope = 'local';

  async gitState(): Promise<GitState | null> {
    const git = (args: string[]) => promisify(execFile)('git', ['-C', this.cwd, ...args], { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout, () => null);
    const [head, config, refs] = await Promise.all([git(['rev-parse', '--abbrev-ref', 'HEAD']), git(GIT_STATE.config), git(GIT_STATE.refs)]);
    return head === null ? null : { head, config: config ?? '', refs: refs ?? '' };
  }

  ghApi(args: string[], input: string | null, timeoutMs: number): Promise<GhAnswer> {
    return ghApiAnswer('gh', ['api', ...args], input, timeoutMs);
  }

  async pluginSettingsTexts(configDir: string | null): Promise<string[]> {
    const dir = configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    const files = [...PLUGIN_FILES.config.map((f) => path.join(dir, f)), ...PLUGIN_FILES.project.map((f) => path.join(this.cwd, f))];
    const texts = await Promise.all(files.map((f) => fs.promises.readFile(f, 'utf8').catch(() => null)));
    return texts.filter((t): t is string => t !== null);
  }

  async skillFiles(configDir: string | null): Promise<SkillFile[]> {
    const dir = configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    const folders = async (rel: string) => (await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => `${rel}/${e.name}`);
    const personal = (await folders('skills')).filter((f) => f !== 'skills/synced');
    const synced = (await Promise.all((await folders('skills/synced')).map(folders))).flat();
    const files = await Promise.all([...personal, ...synced].map(async (f) => {
      const text = await readStart(path.join(dir, f, 'SKILL.md'), SKILL_HEAD_BYTES);
      return text === null ? null : { path: `${f}/SKILL.md`, text };
    }));
    return files.filter((f): f is SkillFile => f !== null);
  }

  async readProjectFile(relative: string): Promise<string | null> {
    return fs.promises.readFile(path.join(this.cwd, relative), 'utf8').catch(() => null);
  }

  async pullRequestView(pr: number, repo: string | null, fields: string, timeoutMs: number): Promise<{ json: string } | { error: string }> {
    try {
      const args = ['pr', 'view', String(pr), ...(repo ? ['-R', repo] : []), '--json', fields];
      const { stdout } = await promisify(execFile)('gh', args, { cwd: this.cwd, windowsHide: true, timeout: timeoutMs });
      return { json: stdout };
    } catch (e) {
      return { error: failureReason(e, timeoutMs) };
    }
  }

  launchSpec(options: SpawnOptions): LaunchSpec {
    return { command: options.command, args: options.args, cwd: options.cwd ?? this.cwd, env: sessionEnv(options), stop: { kind: 'local' } };
  }

  shell(command: string, kind: ShellKind, env: Record<string, string>): ShellSpawn & { shellName: string } {
    const { command: program, args, name } = localShell(command, kind, process.platform, env);
    return { command: program, args, cwd: this.cwd, env: sessionEnv({ env }), shellName: name };
  }
}
