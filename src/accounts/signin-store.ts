// Where Claude Code keeps an account's sign-in (issue #342): a file in the account's sign-in folder on Windows,
// Linux and in containers, and a Keychain entry named from the folder on macOS (Claude Code's own code, and the
// Mac probe of 2026-10-27). Ledung never reads a sign-in from it. It only removes one when its account is removed:
// Claude Code's own `claude auth logout` would also clear the account details in the Claude Code folder every
// session shares (.claude.json's oauthAccount; probe of 2026-10-27, review of #342 R2-M4), and so change what the
// computer's own login shows.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dockerExecArgs, shellFolder, type LoginPlace } from './signin.ts';
import { runWithInput } from '../runners/runner.ts';

/** The sign-in file in a sign-in folder, outside macOS. */
export const CREDENTIALS = '.credentials.json';

/** Runs a command with text on its standard input; for the tests to replace. */
export type RunInput = (command: string, args: string[], input: string | null, timeoutMs: number) => Promise<{ stdout: string }>;

/**
 * The macOS Keychain entry of a sign-in folder: "Claude Code-credentials-" and the first 8 hex of the sha256 of
 * the path as written, NFC (Claude Code's code; one entry per folder in the Mac probe), with the macOS user as
 * its account.
 */
export function keychainEntry(folder: string, user = os.userInfo().username): { service: string; account: string } {
  return { service: `Claude Code-credentials-${createHash('sha256').update(folder.normalize('NFC')).digest('hex').slice(0, 8)}`, account: user };
}

/**
 * Removes the account's sign-in at that place and nothing else: its file, or its Keychain entry. Never reads it,
 * never throws (a removal that fails leaves a sign-in nobody uses, which `/login` there replaces).
 */
export async function removeSignIn(place: LoginPlace, platform = process.platform, run: RunInput = runWithInput): Promise<void> {
  try {
    if (place.kind === 'docker') {
      await run('docker', [...dockerExecArgs(place), 'sh', '-c', `rm -f ${shellFolder(place.folder)}/${CREDENTIALS}`], null, 20000);
    } else if (platform === 'darwin') {
      const { service, account } = keychainEntry(place.folder);
      await run('security', ['delete-generic-password', '-a', account, '-s', service], null, 20000);
    } else {
      fs.rmSync(path.join(place.folder, CREDENTIALS), { force: true });
    }
  } catch {
    // Not there, or the container is gone: nothing to remove.
  }
}
