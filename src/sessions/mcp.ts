// A running session's MCP servers (issue #118): their status, and reconnecting one, so an MCP server that
// was updated is picked up without stopping the session. Both go to Claude Code as control requests
// through the SDK's query (mcp_status, mcp_reconnect), which the session host passes on like every other
// line: hosts from before this change need nothing new.
//
// What could be missing is Claude Code's side: one too old to know the request answers with an error or
// not at all, and the person is told to restart the session instead of waiting on nothing.
import type { McpServerInfo } from '../shared/protocol.ts';

/** The two calls of the SDK's Query this needs. */
export interface McpQuery {
  mcpServerStatus(): Promise<{ name: string; status: string; error?: string; serverInfo?: { name: string; version: string }; source?: string; tools?: unknown[] }[]>;
  reconnectMcpServer(name: string): Promise<void>;
}

export const RESTART_HINT = 'restart the session to use this';
export const STATUS_TIMEOUT_MS = 15_000;
/** A server started with npx may install itself first. */
export const RECONNECT_TIMEOUT_MS = 120_000;

export class McpError extends Error {}

/** Claude Code's answer to a control request it does not know (or an SDK without the call). */
const UNKNOWN_REQUEST = /unsupported control|unknown (control )?(request )?subtype|unsupported subtype|is not a function/i;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpError(`Claude Code gave no answer to ${what} in ${Math.round(ms / 1000)} s; its version may be too old for it: ${RESTART_HINT}.`)), ms);
    timer.unref();
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** An error from Claude Code, in words for the page and the manager. */
function explain(e: unknown, what: string): McpError {
  if (e instanceof McpError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (UNKNOWN_REQUEST.test(message)) return new McpError(`This session's Claude Code can't ${what} (${message}): ${RESTART_HINT}.`);
  return new McpError(`Could not ${what}: ${message}`);
}

/**
 * The session's servers as Claude Code reports them, Ledung's own included, without their config.
 * `own`: the names of Ledung's tool server (it runs inside Ledung, so restarting it is not Claude Code's).
 */
export async function mcpServers(q: McpQuery, own: readonly string[], timeoutMs = STATUS_TIMEOUT_MS): Promise<McpServerInfo[]> {
  let list;
  try {
    if (typeof q.mcpServerStatus !== 'function') throw new Error('mcpServerStatus is not a function');
    list = await within(q.mcpServerStatus(), timeoutMs, 'the MCP status');
  } catch (e) {
    throw explain(e, 'list its MCP servers');
  }
  return (Array.isArray(list) ? list : []).map((s) => ({
    name: String(s.name),
    status: String(s.status),
    error: typeof s.error === 'string' && s.error ? s.error : null,
    version: s.serverInfo ? `${s.serverInfo.name} ${s.serverInfo.version}` : null,
    tools: Array.isArray(s.tools) ? s.tools.length : 0,
    canReconnect: s.source !== 'sdk' && !own.includes(String(s.name)),
  }));
}

/**
 * Reconnects one server the session already has, then gives the status as it is after. Only a name
 * Claude Code just listed: nothing here can add a server, which a level B session must never gain.
 */
export async function reconnectMcp(q: McpQuery, name: string, own: readonly string[], timeouts = { status: STATUS_TIMEOUT_MS, reconnect: RECONNECT_TIMEOUT_MS }): Promise<McpServerInfo[]> {
  const before = await mcpServers(q, own, timeouts.status);
  const server = before.find((s) => s.name === name);
  if (!server) {
    const names = before.map((s) => s.name).join(', ') || 'none';
    throw new McpError(`This session has no MCP server named "${name}". Its servers: ${names}.`);
  }
  if (!server.canReconnect) throw new McpError(`"${name}" is Ledung's own tool server, which runs inside Ledung; it can't be reconnected.`);
  try {
    if (typeof q.reconnectMcpServer !== 'function') throw new Error('reconnectMcpServer is not a function');
    await within(q.reconnectMcpServer(name), timeouts.reconnect, `reconnecting "${name}"`);
  } catch (e) {
    throw explain(e, `reconnect "${name}"`);
  }
  return mcpServers(q, own, timeouts.status);
}

/** One server per line, for a manager. */
export function formatServers(servers: McpServerInfo[]): string {
  if (!servers.length) return 'No MCP servers.';
  return servers.map((s) =>
    `- ${s.name}: ${s.status}${s.version ? ` (${s.version})` : ''}${s.tools ? `, ${s.tools} tool${s.tools === 1 ? '' : 's'}` : ''}` +
    `${s.error ? `; error: ${s.error}` : ''}${s.canReconnect ? '' : ' (Ledung\'s own; not reconnectable)'}`).join('\n');
}
