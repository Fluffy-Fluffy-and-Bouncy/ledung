// Read-only git for the Files pane (issue #225, a test feature): the diff of a session's changes and which
// names .gitignore leaves out. The folder belongs to an agent, so its .git/config, .gitattributes and
// environment may name programs for git to run (an external diff, a textconv, an fsmonitor, hooks); none
// of them may run here (research notes for #225, "a new risk"). So git is started without a shell, with
// those switched off on the command line, an environment with no GIT_* settings from Ledung's own, a
// time limit and a cap on what it may print.
import { spawn } from 'node:child_process';
import os from 'node:os';

/** What a read may print before it is cut off. */
export const GIT_READ_MAX_BYTES = 1024 * 1024;

/**
 * `-c` settings that come before every command. The command line wins over the repository's config, so
 * these hold whatever the folder's .git/config says. Each one is tested in test/files-pane.test.ts.
 */
export const GIT_HARDENING: readonly string[] = [
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${os.devNull}`,
  '-c', 'diff.external=',
  '-c', 'core.pager=cat',
  '-c', 'core.quotePath=false',
  '-c', 'protocol.allow=never',
];

/** Ledung's environment without anything that steers git: GIT_EXTERNAL_DIFF, GIT_CONFIG_PARAMETERS, GIT_DIR and the rest. */
export function gitEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(from)) if (!/^GIT_/i.test(k)) env[k] = v;
  // No lock files written by a read, no pager, no prompt for a password. The system config stays: only an
  // administrator writes it, and it may hold safe.directory.
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
}

export interface GitRead {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The output reached the cap and git was stopped there. */
  truncated: boolean;
}

/** Runs `git <hardening> <args>` in `cwd`, never through a shell, and gives what it printed, cut at `maxBytes`. */
export function gitRead(cwd: string, args: readonly string[], opts: { input?: string; maxBytes?: number; timeoutMs?: number } = {}): Promise<GitRead> {
  const max = opts.maxBytes ?? GIT_READ_MAX_BYTES;
  return new Promise((resolve) => {
    const child = spawn('git', [...GIT_HARDENING, ...args], {
      cwd, env: gitEnv(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = '';
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 15000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = max - size;
      if (chunk.length > room) {
        out.push(chunk.subarray(0, room));
        size = max;
        truncated = true;
        child.kill();
        return;
      }
      out.push(chunk);
      size += chunk.length;
    });
    child.stderr.on('data', (c: Buffer) => { if (stderr.length < 4000) stderr += c.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: e.message, truncated: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr, truncated });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });
}
