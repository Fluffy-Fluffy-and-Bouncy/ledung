// The relay admin's side of "Invite a computer" (issue #237), in the admin's own Ledung.
//
// - The admin key: made here, kept in relay-admin.json in the data folder (private to this user), and shown only as
//   its SHA-256, which the admin puts in the relay's config as "adminKeySha256" (Martin, question #405, default 1:
//   only the hash travels, as for tunnel secrets, Q398).
// - The Cloudflare zone token: typed once into Settings → Relay and kept in the same file; never in the config,
//   never sent to the page, which sees only that one is set (#405 default 3), and never on the relay server (Q400).
// - Invites go to the relay's admin API with the key (relay/README.md); the relay reserves the name and hands out a
//   one-time token, which becomes the join code with the relay's address.
// - Computers that joined wait for their CAA record. This Ledung asks the relay for them once a minute while an invite
//   is open or a computer waits (#405 default 4), and shows each as an Approve card in Waiting for you. Approve writes
//   the record through Cloudflare (refusing a name that has one already), then tells the relay it is done.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_NAME } from '../config.ts';
import { caaRecord, caaValue } from '../server/acme.ts';
import type { NewComputerInfo, RelayAdminView, RelayInviteInfo } from '../shared/protocol.ts';
import { Cloudflare } from './cloudflare.ts';
import { joinCode } from './join-code.ts';
import { secureRelay } from './tunnel.ts';

export const ADMIN_FILE = 'relay-admin.json';
/** How often the relay is asked for new computers while something is pending. */
export const POLL_MS = 60_000;
/** An ACME account URL as a CA gives it: https, and nothing that could break out of the CAA value. */
const SAFE_ACCOUNT_URL = (url: string) => /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,=%-]{1,500}$/.test(url);

interface Saved {
  relay?: string;
  adminKey?: string;
  cloudflareToken?: string;
}

export interface RelayAdminOptions {
  /** userDataDir(). */
  dir: string;
  /** New computers changed: to open pages (Waiting for you). */
  onComputers: (computers: NewComputerInfo[]) => void;
  /** Tests: a stand-in for the relay's admin API and Cloudflare's. */
  fetch?: typeof fetch;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (line: string) => void;
}

/** What the relay's admin API says about one computer (relay/relay.ts). */
interface RelayComputer {
  name: string;
  owner: string;
  host: string;
  accountUrl: string | null;
  enrolledAt: number | null;
  approved: boolean;
}

export class RelayAdmin {
  private readonly opts: RelayAdminOptions;
  private readonly fetch: typeof fetch;
  private readonly log: (line: string) => void;
  private computers: Omit<NewComputerInfo, 'approvable'>[] = [];
  private openInvites = 0;
  private timer: unknown = null;
  private stopped = false;

  constructor(opts: RelayAdminOptions) {
    this.opts = opts;
    this.fetch = opts.fetch ?? fetch;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /** At start: one look at the relay, if this Ledung is its admin, to bring back cards still waiting. */
  start(): void {
    if (this.ready()) void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer);
    this.timer = null;
  }

  view(): RelayAdminView {
    const s = this.saved();
    return {
      relay: s.relay ?? null,
      keySha256: s.adminKey ? sha256(s.adminKey) : null,
      tokenSet: !!s.cloudflareToken,
    };
  }

  /** The Approve cards for Waiting for you. */
  newComputers(): NewComputerInfo[] {
    const approvable = !!this.saved().cloudflareToken;
    return this.computers.map((c) => ({ ...c, approvable }));
  }

  /** Settings → Relay: the relay's address, and the Cloudflare token (write-only: "" removes it, absent keeps it). */
  update(change: { relay?: unknown; cloudflareToken?: unknown }): RelayAdminView {
    const s = this.saved();
    if (change.relay !== undefined) {
      if (typeof change.relay !== 'string') throw new Error('The relay is an address such as wss://relay.example.org.');
      const relay = change.relay.trim().replace(/\/+$/, '');
      if (!relay) delete s.relay;
      else {
        let url: URL;
        try {
          url = new URL(relay);
        } catch {
          throw new Error('The relay is an address such as wss://relay.example.org.');
        }
        if (!secureRelay(relay) || url.pathname !== '/' || url.search || url.hash || url.username) {
          throw new Error('The relay is an address such as wss://relay.example.org: wss://, no path (ws:// only on this computer).');
        }
        s.relay = `${url.protocol}//${url.host}`;
      }
    }
    if (change.cloudflareToken !== undefined) {
      if (typeof change.cloudflareToken !== 'string' || /\s/.test(change.cloudflareToken.trim())) throw new Error('Paste the Cloudflare API token as it is.');
      const token = change.cloudflareToken.trim();
      if (token) s.cloudflareToken = token;
      else delete s.cloudflareToken;
    }
    this.write(s);
    // The cards' Approve follows the token.
    if (change.cloudflareToken !== undefined && this.computers.length) this.opts.onComputers(this.newComputers());
    return this.view();
  }

  /** Makes a new admin key (replacing any), and returns the view with its hash for the relay's config. */
  makeKey(): RelayAdminView {
    this.write({ ...this.saved(), adminKey: crypto.randomBytes(32).toString('base64url') });
    this.log('Relay admin: made a new admin key; put its SHA-256 (Settings → Relay) in the relay\'s config as "adminKeySha256".');
    return this.view();
  }

  /** Invite a computer: the relay reserves the name and gives a one-time token, shown once as the join code. */
  async invite(owner: unknown, name: unknown): Promise<RelayInviteInfo & { code: string }> {
    if (typeof owner !== 'string' || !owner.trim() || owner.length > 100) throw new Error('Say whose computer it is (the owner\'s name).');
    if (name !== undefined && name !== null && name !== '' && typeof name !== 'string') throw new Error('The name is letters, digits and "-".');
    const answer = await this.relayCall<RelayInviteInfo & { token: string }>('POST', '/admin/invites', { owner: owner.trim(), ...(name ? { name: String(name).trim() } : {}) });
    this.openInvites++;
    this.later(POLL_MS);
    this.log(`Relay admin: invited a computer for ${owner.trim()} as ${answer.host}.`);
    const { token, ...invite } = answer;
    return { ...invite, code: joinCode(this.saved().relay!, token) };
  }

  /** Invites not used yet, and the computers that joined, for Settings → Relay. */
  async list(): Promise<{ invites: RelayInviteInfo[]; computers: NewComputerInfo[] }> {
    const invites = (await this.relayCall<{ invites: RelayInviteInfo[] }>('GET', '/admin/invites')).invites;
    this.openInvites = invites.length;
    await this.poll();
    return { invites, computers: this.newComputers() };
  }

  async revokeInvite(id: string): Promise<void> {
    await this.relayCall('DELETE', `/admin/invites/${encodeURIComponent(id)}`);
  }

  /**
   * Approve: the new computer's CAA record, through Cloudflare with the token on this computer, then marked done on
   * the relay. A name that has a CAA record already is refused by the Cloudflare step, never changed.
   */
  async approve(name: string): Promise<{ record: string }> {
    const token = this.saved().cloudflareToken;
    if (!token) throw new Error('No Cloudflare token is set in Settings → Relay; copy the record and add it by hand.');
    await this.poll();
    const computer = this.computers.find((c) => c.name === name);
    if (!computer) throw new Error(`No computer named ${name} waits for its CAA record.`);
    await new Cloudflare(token, this.fetch).addCaa({ name: computer.host, value: caaValue(computer.accountUrl) });
    await this.relayCall('POST', `/admin/computers/${encodeURIComponent(name)}/approved`, {});
    this.log(`Relay admin: wrote the CAA record for ${computer.host}.`);
    this.set(this.computers.filter((c) => c.name !== name));
    return { record: computer.record };
  }

  /** Without a token: the admin added the record by hand (Copy), so the computer stops waiting. */
  async markAdded(name: string): Promise<void> {
    if (!this.computers.some((c) => c.name === name)) throw new Error(`No computer named ${name} waits for its CAA record.`);
    await this.relayCall('POST', `/admin/computers/${encodeURIComponent(name)}/approved`, {});
    this.set(this.computers.filter((c) => c.name !== name));
  }

  /** Asks the relay for computers waiting for their record; keeps asking every minute while anything is pending. */
  private async poll(): Promise<void> {
    if (!this.ready()) return;
    try {
      const { computers } = await this.relayCall<{ computers: RelayComputer[] }>('GET', '/admin/computers');
      this.set(computers.flatMap((c) => {
        // What the relay says is checked before it can reach a card or Cloudflare: a name and an account URL that
        // can't break out of the record (the relay is not trusted with more than names).
        if (c.approved || !c.accountUrl || !SAFE_ACCOUNT_URL(c.accountUrl) || !PUBLIC_NAME.test(c.host)) return [];
        return [{ name: c.name, owner: c.owner, host: c.host, accountUrl: c.accountUrl, record: caaRecord(c.host, c.accountUrl), enrolledAt: c.enrolledAt ?? 0 }];
      }));
    } catch (e) {
      this.log(`Relay admin: ${(e as Error).message}`);
    }
    if (this.openInvites > 0 || this.computers.length > 0) this.later(POLL_MS);
  }

  private later(ms: number): void {
    if (this.stopped || this.timer !== null) return;
    const set = this.opts.setTimer ?? ((fn, wait) => setTimeout(fn, wait).unref());
    this.timer = set(() => {
      this.timer = null;
      void this.poll();
    }, ms);
  }

  private set(computers: Omit<NewComputerInfo, 'approvable'>[]): void {
    const same = JSON.stringify(computers) === JSON.stringify(this.computers);
    this.computers = computers;
    if (!same) this.opts.onComputers(this.newComputers());
  }

  private ready(): boolean {
    const s = this.saved();
    return !!s.relay && !!s.adminKey;
  }

  /** One call to the relay's admin API with the admin key; its answer, or its refusal in words. */
  private async relayCall<T>(method: string, route: string, body?: unknown): Promise<T> {
    const s = this.saved();
    if (!s.relay) throw new Error('Set the relay\'s address in Settings → Relay first.');
    if (!s.adminKey) throw new Error('Make the admin key in Settings → Relay first, and put its SHA-256 in the relay\'s config.');
    const relay = new URL(s.relay);
    const url = `${relay.protocol === 'wss:' ? 'https:' : 'http:'}//${relay.host}${route}`;
    let res: Response;
    try {
      res = await this.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${s.adminKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`The relay at ${relay.host} could not be reached: ${(e as Error).message}`);
    }
    const answer = await res.json().catch(() => ({})) as { error?: unknown };
    if (res.status === 401) throw new Error('The relay did not accept the admin key: is its SHA-256 in the relay\'s config as "adminKeySha256"?');
    if (!res.ok) throw new Error(typeof answer.error === 'string' ? `The relay refused: ${answer.error}` : `The relay refused (${res.status}).`);
    return answer as T;
  }

  private file(): string {
    return path.join(this.opts.dir, ADMIN_FILE);
  }

  private saved(): Saved {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Saved;
      return {
        ...(typeof raw.relay === 'string' ? { relay: raw.relay } : {}),
        ...(typeof raw.adminKey === 'string' ? { adminKey: raw.adminKey } : {}),
        ...(typeof raw.cloudflareToken === 'string' ? { cloudflareToken: raw.cloudflareToken } : {}),
      };
    } catch {
      return {};
    }
  }

  /** Written whole and renamed into place, private to this user (0600 on macOS and Linux; the profile's on Windows). */
  private write(saved: Saved): void {
    const temp = `${this.file()}.${process.pid}.new`;
    fs.writeFileSync(temp, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file());
  }
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
