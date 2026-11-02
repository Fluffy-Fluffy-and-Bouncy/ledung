// Runs Claude Code inside a project's running container through `docker exec -i`.
//
// Claude runs in its own process group (`setsid -w`), and the group's id goes into a pid file, so
// stopping ends everything the session started inside the container, not just the `docker exec`
// client (docs/steps/step-1a-spike.md, finding 3; the stopping itself is in src/host/stop.ts).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import type { FileRead } from '../sessions/flow-files.ts';
import { FLOW_IN_FOLDER, FLOW_TEXT_FILE } from '../shared/flow.ts';
import { FileError } from '../sessions/files.ts';

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

  /** `args` are the script's $1, $2 …; `maxBuffer` raises execFile's 1 MB default for a large answer. */
  private exec(script: string, timeout?: number, args: string[] = [], maxBuffer?: number): Promise<{ stdout: string }> {
    const user = this.project.user ? ['-u', this.project.user] : [];
    return run('docker', ['exec', ...user, this.project.container, 'sh', '-c', script, 'sh', ...args], { windowsHide: true, timeout, ...(maxBuffer ? { maxBuffer } : {}) });
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

  /**
   * Text files inside the project folder, with the file viewer's rules applied in the container (issue #310): links
   * resolved first (readlink -f, which busybox has too), refused when they lead outside the folder, are not a file,
   * are larger than `maxBytes`, have a NUL byte in their start or go past `budget` bytes in all. One `docker exec`
   * for all, the names as arguments so the command line doesn't grow with the script (review of #310, finding 1).
   * Each is its text, missing, or refused with the reason; all refused when the container can't be reached.
   */
  async readInsideProject(files: string[], maxBytes: number, budget: number): Promise<Map<string, FileRead>> {
    if (!files.length) return new Map();
    const mark = `--ledung-file-${randomUUID()}--`;
    let stdout: string;
    try {
      ({ stdout } = await this.exec(INSIDE_PROJECT_SCRIPT, 15000, [mark, this.cwd, String(Math.floor(maxBytes)), String(Math.floor(budget)), ...files], budget + 1024 * 1024));
    } catch (e) {
      // docker's own words, not the command (which is the whole script).
      const said = (e as { stderr?: string }).stderr?.trim().split('\n')[0] || (e as { killed?: boolean }).killed && 'no answer within 15 s' || 'docker exec failed';
      const why = `the container "${this.project.container}" could not be read (${said})`;
      return new Map(files.map((f) => [f, { refused: why }]));
    }
    return splitMarked(stdout, files, mark);
  }

  /**
   * The .md files in the flow folder's briefs/ and overlays/, its manager.md (issues #311, #322) and the flows in
   * flows/ (#447), by their path there; none when it can't be read.
   */
  async listFlowFolder(): Promise<string[]> {
    try {
      const { stdout } = await this.exec(LIST_FLOW_SCRIPT, 15000, [this.cwd]);
      return stdout.split('\n').filter((l) => FLOW_TEXT_FILE.test(l) || FLOW_IN_FOLDER.test(l)).slice(0, 600);
    } catch {
      return [];
    }
  }

  /**
   * Writes files into the project's .ledung/workflow in the container (issue #311), with WRITE_FLOW_SCRIPT: first one
   * exec that checks them all (no link on the way, nothing in the way that isn't a folder or file), then one per file
   * with its text on stdin, so no text is ever on a command line and its size is not limited by one. A flow deleted or
   * renamed (#447) is removed by one exec of its own, with the same checks.
   */
  async writeFlowFiles(files: ({ path: string; text: string } | { path: string; remove: true })[]): Promise<void> {
    const fail = (e: unknown): never => {
      const said = (e as { stdout?: string }).stdout?.trim().split('\n').pop() || (e as { stderr?: string }).stderr?.trim().split('\n')[0] || 'docker exec failed';
      throw new FileError(`The container "${this.project.container}" refused the save: ${said}`);
    };
    await this.exec(WRITE_FLOW_SCRIPT, 15000, ['check', this.cwd, ...files.map((f) => f.path)]).catch(fail);
    for (const f of files) {
      if ('remove' in f) await this.exec(WRITE_FLOW_SCRIPT, 15000, ['remove', this.cwd, f.path]).catch(fail);
      else await this.execInput(WRITE_FLOW_SCRIPT, ['write', this.cwd, f.path], f.text, 30000).catch(fail);
    }
  }

  /** `docker exec -i`, `input` on its stdin. */
  private execInput(script: string, args: string[], input: string, timeout: number): Promise<{ stdout: string }> {
    const user = this.project.user ? ['-u', this.project.user] : [];
    return new Promise((resolve, reject) => {
      const child = execFile('docker', ['exec', '-i', ...user, this.project.container, 'sh', '-c', script, 'sh', ...args], { windowsHide: true, timeout }, (e, stdout, stderr) => {
        if (e) reject(Object.assign(e, { stdout, stderr }));
        else resolve({ stdout });
      });
      child.stdin?.end(input);
    });
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

/**
 * The script readInsideProject runs: $1 the mark, $2 the project folder, $3 the most one file may have, $4 the most
 * all may have, then the files. Each gets a line "<mark> <index> <status>", "ok" followed by its text: only a file
 * whose real path is inside the folder's real path, a plain file within the limits, with no NUL byte in its first
 * 8 KB (its start is as long with the NUL bytes taken out as with them).
 */
export const INSIDE_PROJECT_SCRIPT = [
  'mark=$1; root=$(readlink -f -- "$2") || { echo "$mark - unreachable"; exit 0; }; max=$3; left=$4; shift 4; i=0',
  'for f in "$@"; do',
  '  p="$root/$f"',
  '  if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo "$mark $i missing"',
  '  else',
  '    r=$(readlink -f -- "$p")',
  '    case "$r" in',
  '      "$root"/*)',
  '        if [ ! -f "$r" ] || [ ! -r "$r" ]; then echo "$mark $i refused is not a file that can be read"',
  '        else',
  '          n=$(wc -c < "$r")',
  '          if [ "$n" -gt "$max" ]; then echo "$mark $i refused is larger than $max bytes"',
  '          elif [ "$n" -gt "$left" ]; then echo "$mark $i refused is past what the texts may have together"',
  String.raw`          elif [ "$(head -c 8192 "$r" | tr -d '\000' | wc -c)" != "$(head -c 8192 "$r" | wc -c)" ]; then echo "$mark $i refused is not a text file"`,
  '          else left=$((left - n)); echo "$mark $i ok"; cat -- "$r"',
  '          fi',
  '        fi;;',
  '      *) echo "$mark $i refused leads outside the project folder";;',
  '    esac',
  '  fi',
  '  i=$((i + 1))',
  'done',
].join('\n');

/**
 * listFlowFolder's script: $1 the project folder; prints manager.md, briefs/<name>.md, overlays/<name>.md and
 * flows/<name>.json, one a line (issues #311, #322, #447).
 */
export const LIST_FLOW_SCRIPT = [
  'w="$1/.ledung/workflow"',
  '[ -f "$w/manager.md" ] && echo manager.md',
  'for d in briefs overlays; do for f in "$w/$d"/*.md; do [ -f "$f" ] && echo "$d/${f##*/}"; done; done',
  'for f in "$w/flows"/*.json; do [ -f "$f" ] && echo "flows/${f##*/}"; done',
  'exit 0',
].join('\n');

/**
 * writeFlowFiles's script (issue #311): $1 "check", "write" or "remove", $2 the project folder, then the files by their
 * path in .ledung/workflow (checked against the format's names before). Every folder on the way and the file must be no
 * link, the folders folders and the file a file; "check" checks them all, "write" makes the folders and writes the one
 * file from stdin beside itself, then renames it over the old one, "remove" takes the one file away (a flow deleted or
 * renamed, #447). A refusal is the last line printed, with exit code 3.
 */
export const WRITE_FLOW_SCRIPT = [
  'mode=$1; root=$(readlink -f -- "$2") || { echo "the project folder is not in the container"; exit 3; }; shift 2',
  'for f in "$@"; do',
  '  d=$root; rest=".ledung/workflow/$f"',
  '  while [ "${rest#*/}" != "$rest" ]; do',
  '    d="$d/${rest%%/*}"; rest=${rest#*/}',
  `    if [ -L "$d" ]; then echo "\${d#"$root"/} is a link; the builder writes only into the project's own .ledung/workflow folder"; exit 3`,
  '    elif [ ! -e "$d" ]; then if [ "$mode" = write ]; then mkdir -- "$d" || { echo "${d#"$root"/} could not be made"; exit 3; }; elif [ "$mode" = remove ]; then exit 0; fi',
  '    elif [ ! -d "$d" ]; then echo "${d#"$root"/} is not a folder"; exit 3',
  '    fi',
  '  done',
  '  p="$d/$rest"',
  `  if [ -L "$p" ]; then echo "$f is a link; the builder writes only into the project's own .ledung/workflow folder"; exit 3`,
  '  elif [ -e "$p" ] && [ ! -f "$p" ]; then echo "$f is not a file"; exit 3',
  '  fi',
  '  if [ "$mode" = remove ]; then rm -f -- "$p" || { echo "$f could not be removed"; exit 3; }; fi',
  '  if [ "$mode" = write ]; then',
  '    t="$p.ledung-$.tmp"',
  '    if [ -e "$t" ] || [ -L "$t" ]; then echo "$f could not be written: $t is in the way"; exit 3; fi',
  '    if (set -C; cat > "$t") && mv -f -- "$t" "$p"; then :; else rm -f -- "$t"; echo "$f could not be written"; exit 3; fi',
  '  fi',
  'done',
].join('\n');

/** The files readInsideProject's script printed, by name; one it said nothing about counts as missing. */
export function splitMarked(stdout: string, files: string[], mark: string): Map<string, FileRead> {
  const found = new Map<string, FileRead>(files.map((f) => [f, { missing: true }]));
  for (const chunk of stdout.split(`${mark} `).slice(1)) {
    const nl = chunk.indexOf('\n');
    const [index, status, ...why] = (nl < 0 ? chunk : chunk.slice(0, nl)).split(' ');
    if (index === '-') return new Map(files.map((f) => [f, { refused: "the project folder isn't in the container" }]));
    const file = files[Number(index)];
    if (file === undefined) continue;
    // echo ended the mark's line; cat added nothing, so the text runs up to the next mark.
    if (status === 'ok') found.set(file, { text: (nl < 0 ? '' : chunk.slice(nl + 1)).replace(/^\uFEFF/, '') });
    else if (status === 'refused') found.set(file, { refused: `${file} ${why.join(' ')}.` });
  }
  return found;
}
