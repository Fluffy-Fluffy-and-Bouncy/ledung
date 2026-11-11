// The anonymous daily check-in (#220): how many people run Ledung. Each install makes a random ID once and, once a
// day, sends that ID, the version, the update channel and the operating system, and nothing else. On by default,
// clearly announced (FFBuddha 2026-11-11 15:32, his question #1871; Martin 2026-11-11 16:21, Ledung question #1992):
// a notice on the page, a switch in Settings, and DO_NOT_TRACK=1 honoured. The endpoint is checkin-worker/.
import crypto from 'node:crypto';
import type { CheckInView } from '../shared/protocol.ts';
import type { Channel } from '../shared/version.ts';

/** Where the check-in goes; the Worker in checkin-worker/ answers it once it is deployed (Martin's step, #220). */
export const CHECKIN_URL = 'https://checkin.projectledung.com/v1/checkin';
/** At most one check-in a day. */
export const DAY_MS = 24 * 60 * 60_000;
/** How often Ledung looks whether a day has passed; the send itself stays once a day. */
const LOOK_MS = 60 * 60_000;
/** The first look waits a minute after the start, so a restart loop doesn't send on its way. */
const FIRST_LOOK_MS = 60_000;
const SEND_LIMIT_MS = 10_000;

// Kept in the database's meta table, in the data folder, like the update channel.
export const ID_KEY = 'checkin-id';
export const SWITCH_KEY = 'checkin';
export const NOTICE_KEY = 'checkin-notice';
export const LAST_KEY = 'checkin-last';

/** Exactly what one check-in sends: these four fields, nothing more (#220, Out of scope). */
export interface CheckInPayload {
  id: string;
  version: string;
  channel: Channel;
  os: string;
}

export interface CheckInOptions {
  meta: { get(key: string): string | null; set(key: string, value: string): void };
  version: string;
  /** The update channel (#461). */
  channel: () => Channel;
  /** process.platform by default. */
  os?: string;
  /** process.env by default; read on every send, for DO_NOT_TRACK. */
  env?: NodeJS.ProcessEnv;
  /**
   * Only the npm package checks in: a clone, a release built from it or a throwaway test Ledung would count each
   * fresh data folder as a new user. A URL given here sends from anywhere (tests, trying the Worker locally).
   */
  packaged: boolean;
  url?: string;
  /** Sends one check-in; fetch by default, tests replace it. */
  send?: (url: string, payload: CheckInPayload) => Promise<void>;
  now?: () => number;
}

/** DO_NOT_TRACK set to anything but empty, 0 or false (https://consoledonottrack.com). */
export function doNotTrack(env: NodeJS.ProcessEnv): boolean {
  const v = env.DO_NOT_TRACK?.trim().toLowerCase();
  return !!v && v !== '0' && v !== 'false';
}

export class CheckIn {
  private readonly opts: CheckInOptions;
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;
  private sending = false;

  constructor(opts: CheckInOptions) {
    this.opts = opts;
  }

  /** Makes the install ID if there is none, then looks once a minute after the start and every hour after. */
  start(): void {
    this.id();
    this.first = setTimeout(() => void this.maybeSend(), FIRST_LOOK_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.maybeSend(), LOOK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  /** The random install ID, made the first time it is asked for. */
  id(): string {
    let id = this.opts.meta.get(ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      this.opts.meta.set(ID_KEY, id);
    }
    return id;
  }

  /** The Settings switch: on unless switched off. */
  on(): boolean {
    return this.opts.meta.get(SWITCH_KEY) !== 'off';
  }

  payload(): CheckInPayload {
    return { id: this.id(), version: this.opts.version, channel: this.opts.channel(), os: this.opts.os ?? process.platform };
  }

  private url(): string | null {
    return this.opts.url ?? (this.opts.packaged ? CHECKIN_URL : null);
  }

  view(): CheckInView {
    const dnt = doNotTrack(this.opts.env ?? process.env);
    const noticeSeen = this.opts.meta.get(NOTICE_KEY) !== null;
    return {
      on: this.on(),
      doNotTrack: dnt,
      notice: !noticeSeen,
      sends: this.on() && !dnt && noticeSeen && !!this.url(),
      fromPackage: this.opts.packaged,
      payload: this.payload(),
      url: this.url() ?? CHECKIN_URL,
      lastAt: this.opts.meta.get(LAST_KEY),
    };
  }

  /** The switch, and OK on the notice; switching either way also counts as having seen the notice. */
  act(action: 'on' | 'off' | 'seen'): CheckInView {
    if (action === 'on' || action === 'off') this.opts.meta.set(SWITCH_KEY, action);
    this.opts.meta.set(NOTICE_KEY, 'seen');
    return this.view();
  }

  /**
   * Sends one check-in when it may and a day has passed since the last; returns whether it sent. The time is kept
   * before the send, so a failed or slow send still waits a day: at most one a day, never a retry storm.
   * Never rejects: the timers call it unawaited, and an unhandled rejection (a busy or full database) would stop
   * Ledung itself (privacy and security review of PR #223, S1).
   */
  async maybeSend(): Promise<boolean> {
    const url = this.url();
    if (!url || this.sending) return false;
    this.sending = true;
    try {
      if (!this.view().sends) return false;
      const now = (this.opts.now ?? Date.now)();
      const last = Date.parse(this.opts.meta.get(LAST_KEY) ?? '');
      // A clock set back before the last send sends again rather than waiting out the gap, which could be months.
      if (Number.isFinite(last) && now - last < DAY_MS && now >= last) return false;
      this.opts.meta.set(LAST_KEY, new Date(now).toISOString());
      await (this.opts.send ?? post)(url, this.payload());
      return true;
    } catch {
      // Offline, the endpoint not there yet, or the database busy: nothing to tell anyone; the next look tries again.
      return false;
    } finally {
      this.sending = false;
    }
  }
}

async function post(url: string, payload: CheckInPayload): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_LIMIT_MS),
  });
  if (!res.ok) throw new Error(`check-in answered ${res.status}`);
}
