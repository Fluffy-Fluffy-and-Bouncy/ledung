// A running session's MCP servers and reconnecting one (issue #118). The query objects are stand-ins for
// the SDK's Query, shaped as its sdk.d.ts declares them (SDK 0.3.295): mcpServerStatus() answers with
// { name, status, error?, serverInfo?, config?, source?, tools? }, reconnectMcpServer(name) with nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpServers, reconnectMcp, RESTART_HINT, type McpQuery } from '../src/sessions/mcp.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { Management, type ManagementContext } from '../src/sessions/management.ts';
import { Session, unaskedTool } from '../src/sessions/session.ts';
import { ledungToolServer, USER_APPROVED_TOOLS, type ManagerHandlers, type ToolHandlers } from '../src/sessions/tools.ts';
import type { McpServerInfo } from '../src/shared/protocol.ts';

const OWN = ['ledung'];

/** Claude Code's servers: dns (stdio, with a secret in its environment), a failed one, and Ledung's own. */
function claude(opts: { reconnect?: (name: string) => Promise<void>; status?: () => Promise<unknown> } = {}) {
  const reconnected: string[] = [];
  let version = '1.0.0';
  const q = {
    mcpServerStatus: opts.status ?? (async () => [
      { name: 'dns', status: 'connected', serverInfo: { name: 'dns-manager', version }, scope: 'user', source: 'user',
        config: { type: 'stdio', command: 'node', args: ['dns.js'], env: { CF_TOKEN: 'secret-token-123' } }, tools: [{ name: 'list' }, { name: 'set' }] },
      { name: 'broken', status: 'failed', error: 'spawn ENOENT', source: 'project' },
      { name: 'ledung', status: 'connected', serverInfo: { name: 'ledung', version: '0.1.0' }, source: 'sdk', tools: [{ name: 'ask_user' }] },
    ]),
    reconnectMcpServer: async (name: string) => {
      reconnected.push(name);
      if (opts.reconnect) return opts.reconnect(name);
      version = '1.1.0';
    },
  };
  return { q: q as unknown as McpQuery, reconnected };
}

test('the status lists every server with its state, version and tool count, never its config (secrets)', async () => {
  const { q } = claude();
  const servers = await mcpServers(q, OWN);
  assert.deepEqual(servers, [
    { name: 'dns', status: 'connected', error: null, version: 'dns-manager 1.0.0', tools: 2, canReconnect: true },
    { name: 'broken', status: 'failed', error: 'spawn ENOENT', version: null, tools: 0, canReconnect: true },
    { name: 'ledung', status: 'connected', error: null, version: 'ledung 0.1.0', tools: 1, canReconnect: false },
  ]);
  assert.doesNotMatch(JSON.stringify(servers), /secret-token-123|dns\.js/);
});

test('reconnect restarts the named server and answers with the status as it is after', async () => {
  const { q, reconnected } = claude();
  const after = await reconnectMcp(q, 'dns', OWN);
  assert.deepEqual(reconnected, ['dns']);
  assert.equal(after.find((s) => s.name === 'dns')!.version, 'dns-manager 1.1.0', 'the new server is the one listed');
});

test('reconnect takes only a server the session already has: an unknown name adds nothing (level B)', async () => {
  const { q, reconnected } = claude();
  await assert.rejects(reconnectMcp(q, 'evil', OWN), /no MCP server named "evil"\. Its servers: dns, broken, ledung/);
  assert.deepEqual(reconnected, [], 'Claude Code is never asked');
});

test("Ledung's own tool server is not reconnected", async () => {
  const { q, reconnected } = claude();
  await assert.rejects(reconnectMcp(q, 'ledung', OWN), /Ledung's own tool server/);
  assert.deepEqual(reconnected, []);
});

test('a Claude Code too old for the request says to restart the session, refused or silent', async () => {
  const refused = claude({ status: async () => { throw new Error('Unsupported control request subtype: mcp_status'); } });
  await assert.rejects(mcpServers(refused.q, OWN), (e: Error) => e.message.includes(RESTART_HINT));
  const silent = claude({ status: () => new Promise(() => {}) });
  await assert.rejects(mcpServers(silent.q, OWN, 30), (e: Error) => e.message.includes(RESTART_HINT) && /no answer/.test(e.message));
  const noReconnect = claude({ reconnect: async () => { throw new Error('Unknown subtype: mcp_reconnect'); } });
  await assert.rejects(reconnectMcp(noReconnect.q, 'dns', OWN), (e: Error) => e.message.includes(RESTART_HINT));
});

test("a server that fails to come back is reported with Claude Code's reason, not as too old", async () => {
  const { q } = claude({ reconnect: async () => { throw new Error('Connection closed'); } });
  await assert.rejects(reconnectMcp(q, 'dns', OWN), (e: Error) => /Could not reconnect "dns": Connection closed/.test(e.message) && !e.message.includes(RESTART_HINT));
});

// The manager's side: its own sessions and itself, nobody else's.
function managers() {
  const store = new Store(openDatabase(':memory:'));
  const calls: { op: string; id: string; name?: string; by?: string }[] = [];
  const list: McpServerInfo[] = [{ name: 'dns', status: 'connected', error: null, version: 'dns-manager 1.1.0', tools: 2, canReconnect: true }];
  const ctx = {
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id: string, file: string) => file,
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
    mcp: {
      servers: async (id: string) => (calls.push({ op: 'status', id }), list),
      reconnect: async (id: string, name: string, by: string) => (calls.push({ op: 'reconnect', id, name, by }), list),
    },
  } satisfies ManagementContext;
  const m = new Management(ctx);
  const mk = (id: string, role: 'session' | 'manager', parentId: string | null = null) =>
    store.createSession({ id, project: 'p', runner: 'local', title: `title-${id}`, parentId, permissionMode: 'default', role });
  mk('mgr', 'manager');
  mk('other-mgr', 'manager');
  mk('child', 'session', 'mgr');
  mk('stranger', 'session', 'other-mgr');
  for (const id of ['mgr', 'child', 'stranger']) store.updateSession(id, { status: 'idle' });
  return { m, calls, store };
}

test("a manager lists and reconnects its own session's servers, and its own; the call is recorded as the manager's", async () => {
  const { m, calls } = managers();
  assert.match(await m.mcpStatus('mgr', 'child'), /MCP servers of "title-child":\n- dns: connected \(dns-manager 1\.1\.0\), 2 tools/);
  assert.match(await m.reconnectMcp('mgr', 'child', 'dns'), /Reconnected "dns" in "title-child"; it is now connected\. Its conversation is kept/);
  assert.match(await m.mcpStatus('mgr', undefined), /your own session/);
  assert.match(await m.reconnectMcp('mgr', undefined, 'dns'), /in your own session/);
  assert.deepEqual(calls, [
    { op: 'status', id: 'child' },
    { op: 'reconnect', id: 'child', name: 'dns', by: 'manager "title-mgr"' },
    { op: 'status', id: 'mgr' },
    { op: 'reconnect', id: 'mgr', name: 'dns', by: 'manager "title-mgr"' },
  ]);
});

test("a manager can't touch the servers of a session it did not start, nor of one that has ended", async () => {
  const { m, calls, store } = managers();
  await assert.rejects(m.mcpStatus('mgr', 'stranger'), /not one you started/);
  await assert.rejects(m.reconnectMcp('mgr', 'stranger', 'dns'), /not one you started/);
  store.updateSession('child', { status: 'ended' });
  await assert.rejects(m.reconnectMcp('mgr', 'child', 'dns'), /not running/);
  assert.deepEqual(calls, [], 'no session was asked');
});

test('a level B manager keeps both tools: they reach only its own sessions and servers they already have', () => {
  const handlers = (airgap: boolean): ToolHandlers => ({
    userName: 'Simon', role: 'manager', asksWhom: 'Simon', ask: () => { throw new Error('not called'); }, withdraw: () => '',
    manager: new Proxy({}, { get: () => () => '' }) as ManagerHandlers, airgap,
  });
  const tools = (h: ToolHandlers) => Object.keys((ledungToolServer(h).instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  for (const airgap of [false, true]) {
    for (const t of ['mcp_status', 'reconnect_mcp_server']) assert.ok(tools(handlers(airgap)).includes(t), `${t}, airgap ${airgap}`);
  }
  const session: ToolHandlers = { userName: 'Simon', role: 'session', asksWhom: 'Simon', ask: () => { throw new Error('not called'); }, withdraw: () => '' };
  assert.ok(!tools(session).includes('reconnect_mcp_server'), 'not for a plain session');
});

test('both tools run without a permission prompt, like the other own-session tools', () => {
  for (const t of ['mcp_status', 'reconnect_mcp_server']) {
    assert.ok(unaskedTool(`mcp__ledung__${t}`, []), t);
    assert.ok(unaskedTool(`mcp__ledung__${t}`, USER_APPROVED_TOOLS), `${t}, with the project tools always asked`);
  }
});

// The Session itself, through start(); only the SDK's query is a stand-in.
async function running() {
  const store = new Store(openDatabase(':memory:'));
  const { m: management } = managers();
  const info = store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default', role: 'session' });
  const { q, reconnected } = claude();
  const stream = {
    ...(q as object),
    accountInfo: async () => ({}),
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }),
  };
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon', management,
    runner: { cwd: '.', prepare: async () => {}, currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
    query: (() => stream) as never,
  });
  return { session, store, reconnected };
}

test("a session reconnects through its own Claude Code and says so in its history, by the person's name", async () => {
  const { session, store, reconnected } = await running();
  await assert.rejects(session.mcpServers(), /not running/, 'nothing to ask before it starts');
  await session.start();
  assert.equal((await session.mcpServers()).length, 3);
  const after = await session.reconnectMcp('dns', 'user');
  assert.deepEqual(reconnected, ['dns']);
  assert.equal(after.find((s) => s.name === 'dns')!.version, 'dns-manager 1.1.0');
  const events = store.listMessages('s1', { limit: 50 }).filter((x) => x.kind === 'event').map((x) => x.data.text);
  assert.ok(events.includes('MCP server "dns" reconnected by Simon: connected.'), events.join(' | '));
});
