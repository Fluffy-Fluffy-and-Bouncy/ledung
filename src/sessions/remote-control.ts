// Remote Control for managers (#19): the manager's Claude Code session is reachable from the Claude app,
// named "<project> lead". The bridge runs inside Claude Code, so it lives in the session host with the
// session: a Ledung restart leaves it up, and stopping the session ends it.
//
// The SDK's enableRemoteControl is untyped (SDK 0.3.295, tested 2026-10-12): an SDK without it, or a
// call that fails, means "Remote Control unavailable", never a broken session.
import type { RemoteControlInfo, SessionRole } from '../shared/protocol.ts';

type Enable = (enabled: boolean, name?: string) => Promise<unknown>;

/** The name in the Claude app, for a session that gets Remote Control; null for every other session. */
export function remoteControlName(role: SessionRole, project: string, enabled: boolean): string | null {
  return enabled && role === 'manager' ? `${project} lead` : null;
}

/** The untyped method, bound to its query; null when this SDK has none. */
function method(q: object): Enable | null {
  const f = (q as { enableRemoteControl?: unknown }).enableRemoteControl;
  return typeof f === 'function' ? (f as Enable).bind(q) : null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class RemoteControl {
  info: RemoteControlInfo | null = null;
  private asked = false;
  readonly name: string;
  /** The state changed: for the page. */
  private readonly changed: () => void;
  /** A line for the session's history. */
  private readonly note: (text: string) => void;

  constructor(name: string, changed: () => void, note: (text: string) => void) {
    this.name = name;
    this.changed = changed;
    this.note = note;
  }

  private set(info: RemoteControlInfo | null): void {
    this.info = info;
    this.changed();
  }

  /** Turns it on, once per query. Asking again on a running Claude Code gives the same link (probe 2026-10-13). */
  async enable(q: object): Promise<void> {
    if (this.asked) return;
    this.asked = true;
    const enable = method(q);
    if (!enable) {
      this.set({ state: 'unavailable', url: null, bridge: null, error: "This version of the Agent SDK can't turn Remote Control on." });
      this.note('Remote Control unavailable: this version of the Agent SDK has no Remote Control.');
      return;
    }
    this.set({ state: 'starting', url: null, bridge: null, error: null });
    try {
      const r = (await enable(true, this.name)) as { session_url?: unknown } | undefined;
      const url = typeof r?.session_url === 'string' ? r.session_url : null;
      if (!url) throw new Error('Claude Code gave no session link.');
      // A bridge_state may have come in while this call waited.
      this.set({ state: 'on', url, bridge: this.info?.bridge ?? null, error: null });
      this.note(`Remote Control on, as "${this.name}" in the Claude app: ${url}`);
    } catch (e) {
      this.set({ state: 'unavailable', url: null, bridge: null, error: message(e) });
      this.note(`Remote Control unavailable: ${message(e)}`);
    }
  }

  /** A system message of subtype bridge_state from Claude Code ('ready', then 'connected'): kept as it is. */
  onBridgeState(m: { state?: unknown }): void {
    if (!this.info || this.info.state === 'unavailable' || typeof m.state !== 'string') return;
    if (m.state !== this.info.bridge) this.set({ ...this.info, bridge: m.state });
  }

  /** Turns it off before the session stops, so the Claude app no longer shows it connected. */
  async disable(q: object, timeoutMs = 5000): Promise<void> {
    const on = this.info && this.info.state !== 'unavailable';
    this.info = null;
    const enable = method(q);
    if (!on || !enable) return;
    try {
      await Promise.race([enable(false), new Promise((_, reject) => setTimeout(() => reject(new Error('no answer')), timeoutMs).unref())]);
      this.note('Remote Control off.');
    } catch (e) {
      // Claude Code is stopped right after this anyway, and the bridge ends with it.
      this.note(`Remote Control off (with the session; turning it off first failed: ${message(e)}).`);
    }
  }
}
