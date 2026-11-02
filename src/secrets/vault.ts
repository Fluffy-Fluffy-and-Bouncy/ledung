// Where locked secrets (issue #468) are kept between starts: one file in the user data folder, encrypted with
// AES-256-GCM under a random key that the OS keeps for this user (the manager's a on question #1565, 2026-11-02):
// Windows DPAPI, the macOS Keychain, the Linux secret service, or, where there is none (headless, WSL), an
// owner-only key file. Never in the database or the config. The key is read once and then kept in memory.
//
// The OS tools are run with the key on stdin, never on a command line, which other processes can list.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runWithInput } from '../runners/runner.ts';

/** Keeps the vault's key: null from load when there is none yet. */
export interface KeyGuard {
  /** In plain words, for Settings and the log: "Windows DPAPI" … */
  readonly kind: string;
  load(): Promise<Buffer | null>;
  save(key: Buffer): Promise<void>;
}

const TIMEOUT_MS = 20_000;

function writeOwnerOnly(file: string, data: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const fromHex = (text: string | null): Buffer | null => {
  const hex = text?.trim() ?? '';
  return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
};

/** The key in an owner-only file: the fallback where the OS has no store for it. */
export function fileGuard(file: string): KeyGuard {
  return {
    kind: 'an owner-only key file',
    load: async () => fromHex(readOrNull(file)),
    save: async (key) => writeOwnerOnly(file, key.toString('hex')),
  };
}

/** PowerShell 5.1, which every Windows has, with ProtectedData (CurrentUser). The data comes on stdin as base64. */
const dpapi = (verb: 'Protect' | 'Unprotect') =>
  `Add-Type -AssemblyName System.Security; $d = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
  `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${verb}($d, $null, 'CurrentUser')))`;

/** Windows: the key encrypted with DPAPI for this Windows user, in a file beside the vault. */
export function dpapiGuard(file: string): KeyGuard {
  const run = async (verb: 'Protect' | 'Unprotect', input: string) =>
    (await runWithInput('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', dpapi(verb)], input, TIMEOUT_MS)).stdout.trim();
  return {
    kind: 'Windows DPAPI',
    load: async () => {
      const blob = readOrNull(file)?.trim();
      if (!blob) return null;
      return Buffer.from(await run('Unprotect', blob), 'base64');
    },
    save: async (key) => writeOwnerOnly(file, await run('Protect', key.toString('base64'))),
  };
}

/** macOS: a generic password in the login Keychain, written through `security -i` so the key is never an argument. */
export function keychainGuard(account: string): KeyGuard {
  const service = 'Ledung secrets';
  return {
    kind: 'the macOS Keychain',
    load: async () => {
      try {
        return fromHex((await runWithInput('security', ['find-generic-password', '-s', service, '-a', account, '-w'], null, TIMEOUT_MS)).stdout);
      } catch (e) {
        // 44: no such item yet.
        if ((e as { code?: unknown }).code === 44) return null;
        throw e;
      }
    },
    save: async (key) => {
      await runWithInput('security', ['-i'], `add-generic-password -U -s "${service}" -a "${account}" -w "${key.toString('hex')}"\n`, TIMEOUT_MS);
    },
  };
}

/** Linux: the secret service (GNOME Keyring, KWallet) through secret-tool, which reads the secret on stdin. */
export function secretToolGuard(account: string): KeyGuard {
  const attrs = ['service', 'ledung-secrets', 'account', account];
  return {
    kind: 'the secret service',
    load: async () => {
      try {
        return fromHex((await runWithInput('secret-tool', ['lookup', ...attrs], null, TIMEOUT_MS)).stdout);
      } catch (e) {
        // Exit code 1 with nothing printed: no such item yet.
        if ((e as { code?: unknown }).code === 1 && !(e as { stderr?: string }).stderr?.trim()) return null;
        throw e;
      }
    },
    save: async (key) => {
      await runWithInput('secret-tool', ['store', '--label=Ledung secrets', ...attrs], key.toString('hex'), TIMEOUT_MS);
    },
  };
}

/**
 * The secret service where it answers, else the owner-only file: secret-tool may be missing, or have no
 * D-Bus session to talk to (a server, WSL, a container). A key already in the file stays there.
 */
export function linuxGuard(account: string, file: string): KeyGuard {
  const tool = secretToolGuard(account);
  const plain = fileGuard(file);
  let chosen: KeyGuard | null = null;
  return {
    get kind() {
      return (chosen ?? tool).kind;
    },
    load: async () => {
      const inFile = await plain.load();
      if (inFile) {
        chosen = plain;
        return inFile;
      }
      try {
        const key = await tool.load();
        chosen = tool;
        return key;
      } catch {
        chosen = plain;
        return null;
      }
    },
    save: async (key) => {
      if (chosen !== plain) {
        try {
          await tool.save(key);
          // Read back: secret-tool can exit 0 without a keyring to keep it in.
          if ((await tool.load())?.equals(key)) {
            chosen = tool;
            return;
          }
        } catch {
          // The file below.
        }
      }
      chosen = plain;
      await plain.save(key);
    },
  };
}

/** This computer's guard for the vault in `dataDir`; the Keychain and secret-service entry is named per data folder. */
export function osGuard(dataDir: string, platform: NodeJS.Platform = process.platform): KeyGuard {
  const account = crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16);
  if (platform === 'win32') return dpapiGuard(path.join(dataDir, 'secrets.key'));
  if (platform === 'darwin') return keychainGuard(account);
  return linuxGuard(account, path.join(dataDir, 'secrets.key'));
}

const AAD = Buffer.from('ledung-secrets-v1');

/** The vault file: its entries encrypted under the guard's key. */
export class Vault {
  private readonly file: string;
  private readonly guard: KeyGuard;
  private key: Buffer | null = null;
  /** Writes one after another, so an older state never lands after a newer one. */
  private writing: Promise<void> = Promise.resolve();

  constructor(file: string, guard: KeyGuard) {
    this.file = file;
    this.guard = guard;
  }

  get kind(): string {
    return this.guard.kind;
  }

  /** What the vault holds; [] when there is no vault yet. Throws when there is one but its key can't be had. */
  async read<T>(): Promise<T[]> {
    const text = readOrNull(this.file);
    if (text === null) return [];
    const key = await this.guard.load();
    if (!key) throw new Error(`the key for ${this.file} is missing from ${this.guard.kind}`);
    this.key = key;
    const box = JSON.parse(text) as { v: number; iv: string; tag: string; data: string };
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T[];
  }

  /** Replaces what the vault holds; the first write makes the key. Nothing left: the file goes. */
  write<T>(entries: T[]): Promise<void> {
    const data = JSON.stringify(entries);
    this.writing = this.writing.catch(() => {}).then(async () => {
      if (!entries.length) {
        fs.rmSync(this.file, { force: true });
        return;
      }
      if (!this.key) {
        this.key = (await this.guard.load()) ?? crypto.randomBytes(32);
        await this.guard.save(this.key);
      }
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
      cipher.setAAD(AAD);
      const sealed = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
      writeOwnerOnly(this.file, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: sealed.toString('base64') }));
    });
    return this.writing;
  }
}
