// Where Claude Code keeps an account's sign-in (issue #342): a file in the account's sign-in folder on Windows,
// Linux and in containers, and a Keychain entry named from the folder on macOS (Claude Code's own code, and the
// Mac probe of 2026-10-27). Ledung never reads a sign-in from it. It removes one when its account is removed:
// Claude Code's own `claude auth logout` would also clear the account details in the Claude Code folder every
// session shares (.claude.json's oauthAccount; probe of 2026-10-27, review of #342 R2-M4), and so change what the
// computer's own login shows. The one thing that writes here is `ledung account token` (issue #85), in the user's
// own terminal: Ledung's server and page never see what it writes.
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
 * The record Claude Code itself makes of a CLAUDE_CODE_OAUTH_TOKEN: no refresh token, no expiry (#342: read from
 * Claude Code 2.1.295, and a dummy one stored so was sent and refused with 401, so it is used; the same 401 on
 * 2.1.316, 2026-11-02, with a throwaway Claude folder, issue #85).
 */
export function signInRecord(token: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: null, expiresAt: null, scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null } });
}

/** This computer's sign-in store for a folder: the Keychain on macOS, a file elsewhere. Neither reads a sign-in. */
export function localStore(platform = process.platform, run: RunInput = runWithInput) {
  if (platform === 'darwin') {
    return {
      // `security` exits 44 when there is no such entry; without -w it prints no secret.
      hasSignIn: async (folder: string): Promise<boolean> => {
        const { service, account } = keychainEntry(folder);
        try {
          await run('security', ['find-generic-password', '-a', account, '-s', service], null, 20000);
          return true;
        } catch (e) {
          if ((e as { code?: unknown }).code === 44) return false;
          throw new Error('the Keychain could not be read; if it is locked, `security unlock-keychain` unlocks it');
        }
      },
      // Through `security -i`, so the record is on its standard input, not a command line anyone can list; as hex
      // (-X), so no quoting can break it. -U replaces the entry that is there, and `security -i` exits non-zero
      // when a line fails (probe of 2026-11-02).
      put: async (folder: string, record: string): Promise<void> => {
        const { service, account } = keychainEntry(folder);
        const hex = Buffer.from(record, 'utf8').toString('hex');
        try {
          await run('security', ['-i'], `add-generic-password -U -a "${account}" -s "${service}" -X ${hex}\n`, 20000);
        } catch {
          // A fixed text: what `security` printed stays out of the terminal's scrollback (review of #342, R2-M2).
          throw new Error('the Keychain could not be written; if it is locked, `security unlock-keychain` unlocks it');
        }
      },
    };
  }
  return {
    hasSignIn: async (folder: string): Promise<boolean> => fs.existsSync(path.join(folder, CREDENTIALS)),
    // Whole to a file of its own, readable only by the user, then renamed over the one that is there.
    put: async (folder: string, record: string): Promise<void> => {
      fs.mkdirSync(folder, { recursive: true });
      const temp = path.join(folder, `${CREDENTIALS}.ledung-${process.pid}`);
      try {
        fs.writeFileSync(temp, record, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temp, path.join(folder, CREDENTIALS));
      } finally {
        fs.rmSync(temp, { force: true });
      }
    },
  };
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
