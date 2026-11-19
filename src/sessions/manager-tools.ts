// The tools managers learn (issue #431; Martin, 2026-11-19, Ledung questions #625 "b — Learn in Ledung, never keep
// context-mode" and #649 on magto-mini): Ledung keeps, per computer, which plugins and MCP servers manager sessions
// call and when each was last called. Where the project's workflow turns it on, a manager starts with only the ones
// any manager on this computer called in the last week: the others cost tokens on every turn. Ledung's own tools are
// never part of it. context-mode is never kept: it takes over file reads with its own tools, so it always looks used,
// and it cut a manager's reads of its process files (Magto/agent-workflow#363).
//
// Only narrows: a plugin or server the manager's profile already leaves out stays out. Before managers on this
// computer have a week behind them nothing is dropped (Martin at agent-workflow PR #366: "Start with all tools, after
// a manager has been used for a week, remove the tools it never used").
import { exercisedLine } from '../platform/exercised.ts';
import type { Profile } from './profiles.ts';
import { LEDUNG_SERVER } from './tools.ts';

/** Whether learning applies when the workflow says nothing (Ledung question #650 decides it; off until then). */
export const LEARN_MANAGER_TOOLS_DEFAULT = false;

/** How far back a call counts, and how long managers must have run here before anything is dropped. */
export const LEARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Plugins never kept, however often called (by name, without the "@marketplace"). */
export const NEVER_KEPT = ['context-mode'];

/** A server's name as it appears in its tools' names: anything but letters, digits, _ and - becomes _ (Claude Code's rule). */
export const serverKey = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/** A plugin's name from its id ("name@marketplace"). */
export const pluginName = (id: string) => id.split('@')[0]!;

/**
 * What one tool call shows was used: "server:<key>" for an MCP tool (a plugin's server too, whose key starts with
 * "plugin_<plugin>_"), "plugin:<name>" for a plugin's skill or agent ("<plugin>:<name>"). Ledung's own and built-in
 * tools show nothing.
 */
export function usedBy(tool: string, input: unknown): string[] {
  if (tool.startsWith('mcp__')) {
    const key = tool.slice(5).split('__')[0] ?? '';
    return key && key !== LEDUNG_SERVER ? [`server:${key}`] : [];
  }
  const field = tool === 'Skill' ? 'skill' : tool === 'Agent' || tool === 'Task' ? 'subagent_type' : null;
  const value = field && input && typeof input === 'object' ? (input as Record<string, unknown>)[field] : undefined;
  if (typeof value !== 'string') return [];
  const at = value.indexOf(':');
  return at > 0 ? [`plugin:${value.slice(0, at)}`] : [];
}

/** Every use the content of one assistant message shows. */
export function usedInMessage(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((b) => (b && b.type === 'tool_use' && typeof b.name === 'string' ? usedBy(b.name, b.input) : []));
}

/**
 * The servers a session's init message lists that are the user's own (a config scope or a claude.ai connector), as
 * keys: not Ledung's own, not a profile's own (both "sdk"), not a plugin's (it goes with its plugin).
 */
export function ownServersInInit(servers: unknown): string[] {
  if (!Array.isArray(servers)) return [];
  return servers.flatMap((s) => {
    const name = s && typeof s.name === 'string' ? s.name : '';
    if (!name || s.source === 'sdk' || s.source === 'plugin' || name.startsWith('plugin:')) return [];
    const key = serverKey(name);
    return key === LEDUNG_SERVER ? [] : [key];
  });
}

/** What a manager starting now leaves out. */
export interface LearnedTools {
  /** Plugin ids to turn off. */
  pluginsOff: string[];
  /** The user's MCP servers to take away, as keys (a rule "mcp__<key>" each). */
  serversOff: string[];
}

/**
 * What a manager starting at `now` leaves out, or null while managers here have less than the window behind them.
 * `used`: each use's last time; `seen`: the user's servers sessions here have had; `installed`: the plugin ids the
 * manager's settings name; `since`: when the first manager here started (null: none yet).
 */
export function learnedTools(used: Map<string, number>, seen: string[], installed: string[], since: number | null, now: number): LearnedTools | null {
  if (since === null || now - since < LEARN_WINDOW_MS) return null;
  const recent = new Set([...used].filter(([, at]) => now - at <= LEARN_WINDOW_MS).map(([key]) => key));
  const keys = [...recent];
  const pluginUsed = (id: string) => {
    const name = pluginName(id);
    if (NEVER_KEPT.includes(name)) return false;
    const prefix = `server:plugin_${serverKey(name)}_`;
    return recent.has(`plugin:${name}`) || keys.some((k) => k.startsWith(prefix));
  };
  return {
    pluginsOff: installed.filter((id) => !pluginUsed(id)),
    serversOff: [...new Set(seen)].filter((key) => !recent.has(`server:${key}`) || NEVER_KEPT.some((name) => serverKey(name) === key)).sort(),
  };
}

/**
 * The profile with the learned servers taken away, as rules "mcp__<key>" (a whole server). Only where the profile
 * keeps the user's servers ("all"): otherwise they are gone already, and a profile's own servers stay as it names them.
 * The plugins go off through the plugins-off list, which only touches installed ones.
 */
export function withLearned(p: Profile, learned: LearnedTools): Profile {
  if (p.mcpServers !== 'all' || !learned.serversOff.length) return p;
  return { ...p, disallowedTools: [...new Set([...p.disallowedTools, ...learned.serversOff.map((key) => `mcp__${key}`)])] };
}

/** Where the record lives (the store). */
export interface ManagerToolsStore {
  noteToolUses(keys: string[], at: number): void;
  toolUses(): Map<string, number>;
  noteServersSeen(keys: string[], at: number): void;
  serversSeen(): string[];
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

/** A session the record can be seeded from. */
export interface SeedSession {
  id: string;
  manager: boolean;
  createdAt: number;
  endedAt: number | null;
}

/** The stored SDK lines a seed reads: a session's assistant messages with a tool call, and its init messages. */
export interface SeedSource {
  sessions(): SeedSession[];
  lines(sessionId: string, since: number, kind: 'calls' | 'init'): { at: number; data: string }[];
}

const SEEDED = 'manager-tools-seeded';

/** The EXERCISED line of issue #431, once per run. */
let exercised = false;

/** The record, filled from what sessions on this computer call, and seeded once from what Ledung already stored. */
export class ManagerTools {
  private readonly store: ManagerToolsStore;
  private readonly source: SeedSource;

  constructor(store: ManagerToolsStore, source: SeedSource) {
    this.store = store;
    this.source = source;
  }

  /** A manager's tool calls (an assistant message's content). */
  noteCalls(content: unknown, at = Date.now()): void {
    const keys = usedInMessage(content);
    if (keys.length) this.store.noteToolUses(keys, at);
  }

  /** The user's servers a session started with (its init message's list). */
  noteInit(servers: unknown, at = Date.now()): void {
    const keys = ownServersInInit(servers);
    if (keys.length) this.store.noteServersSeen(keys, at);
  }

  /**
   * Once: what the stored messages of the last window show, managers' calls and every session's servers, so the
   * record need not wait a week to start (Martin at agent-workflow PR #366: "I'm guessing we can do this retroactivly").
   */
  seed(now = Date.now()): void {
    if (this.store.getMeta(SEEDED)) return;
    const from = now - LEARN_WINDOW_MS;
    for (const s of this.source.sessions()) {
      if (s.endedAt !== null && s.endedAt < from) continue;
      if (s.manager) {
        for (const line of this.source.lines(s.id, from, 'calls')) {
          try {
            this.noteCalls(JSON.parse(line.data)?.message?.content, line.at);
          } catch {
            // A line that isn't JSON shows nothing.
          }
        }
      }
      for (const line of this.source.lines(s.id, from, 'init')) {
        try {
          this.noteInit(JSON.parse(line.data)?.mcp_servers, line.at);
        } catch {
          // As above.
        }
      }
    }
    this.store.setMeta(SEEDED, String(now));
  }

  /** What a manager starting now leaves out of `installed` and the servers seen; null: nothing yet. */
  forManager(installed: string[], now = Date.now()): LearnedTools | null {
    this.seed(now);
    const managers = this.source.sessions().filter((s) => s.manager).map((s) => s.createdAt);
    const since = managers.length ? Math.min(...managers) : null;
    const learned = learnedTools(this.store.toolUses(), this.store.serversSeen(), installed, since, now);
    if (learned && !exercised) {
      exercised = true;
      exercisedLine(`EXERCISED #431 manager started with learned tools (${learned.pluginsOff.length} plugins, ${learned.serversOff.length} servers left out)`);
    }
    return learned;
  }
}
