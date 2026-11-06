// Which version of Ledung's tool schema a running session has (issue #164). A session keeps the tool list Claude
// Code was given at its start; after a release it reattaches to the new Ledung with the old list, so a new
// parameter is missing or refused. Ledung records a fingerprint of the list each session's Claude Code was started
// with, tells Claude Code the tools changed when the running Ledung's list differs (MCP
// notifications/tools/list_changed), and notes on the next Ledung call that a restart brings the new tools.
//
// What the notification does, tried with Claude Code 2.1.316 on 2026-11-06 (PR for #164): Claude Code asks for the tool
// list again, and a tool that is new is announced to the session and can be called; a tool the session already had
// keeps the description and parameters it started with, even through ToolSearch. So the notification never clears
// the note: only a new Claude Code process (a start or resume) has the current list.
import crypto from 'node:crypto';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';

/** The note after a Ledung call while the session's tools are older than the running Ledung's (Martin, question #659). */
export const STALE_TOOLS_NOTE =
  "Ledung was updated after this session's tools were loaded, so your Ledung tools may lack new parameters or tools: " +
  'restart this session to get the new tools (stop it and resume it, or ask the person using Ledung to).';

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; result?: { tools?: unknown[] } };
interface Transport {
  start(): Promise<void>;
  send(message: JsonRpc): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: JsonRpc, extra?: unknown) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
}
interface Instance {
  connect(t: Transport): Promise<void>;
  close(): Promise<void>;
  sendToolListChanged(): void;
}
const instanceOf = (server: McpSdkServerConfigWithInstance) => server.instance as unknown as Instance;

/**
 * The fingerprint of a server's tool list as an MCP client gets it: the server's own tools/list answer, asked
 * over a transport of its own, so names, descriptions and the JSON schemas the SDK makes of them all count.
 * Pass a server built for this alone: an MCP server takes one connection.
 */
export async function toolSchemaHash(server: McpSdkServerConfigWithInstance): Promise<string> {
  const instance = instanceOf(server);
  const answers = new Map<unknown, JsonRpc>();
  const transport: Transport = {
    start: async () => {},
    send: async (m) => { if (m.id !== undefined) answers.set(m.id, m); },
    close: async () => { transport.onclose?.(); },
  };
  await instance.connect(transport);
  const ask = async (id: number, method: string, params?: unknown) => {
    transport.onmessage!({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } as JsonRpc);
    // The handlers answer within a few ticks; a schema hash is never worth hanging a start for.
    for (let i = 0; i < 100 && !answers.has(id); i++) await new Promise((r) => setImmediate(r));
    return answers.get(id);
  };
  try {
    await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ledung-schema', version: '1' } });
    const list = await ask(2, 'tools/list');
    const tools = list?.result?.tools;
    if (!Array.isArray(tools)) throw new Error('the tool server gave no tool list');
    return crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex').slice(0, 16);
  } finally {
    await instance.close().catch(() => {});
  }
}

/**
 * Runs `onConnected` once the SDK has connected the server for a session, when a notification can be sent.
 * Returns the server, for the SDK's options.
 */
export function onToolServerConnected(
  server: McpSdkServerConfigWithInstance,
  onConnected: (instance: { sendToolListChanged(): void }) => void,
): McpSdkServerConfigWithInstance {
  const instance = instanceOf(server);
  const connect = instance.connect.bind(instance);
  instance.connect = async (t: Transport) => {
    await connect(t);
    try { onConnected(instance); } catch (e) { console.error(`Ledung tool server: ${(e as Error).message}`); }
  };
  return server;
}
