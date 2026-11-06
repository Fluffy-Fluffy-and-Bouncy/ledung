// A session whose Ledung tools are older than the running Ledung's (issue #164): the tool list's fingerprint, the
// record of the list each session was started with, the "tools changed" notification to a reattached session whose
// list differs, and the note after its next Ledung call (Martin, 2026-11-06, Ledung question #659: "Both: send
// \"tools changed\", and add a note if it doesn't take").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { Management } from '../src/sessions/management.ts';
import { Session } from '../src/sessions/session.ts';
import { STALE_TOOLS_NOTE, toolSchemaHash } from '../src/sessions/tool-schema.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';

// The issue's own case: message_manager gained an `attachments` array in 1.16.0.
const server = (opts: { attachments?: boolean; description?: string } = {}) => createSdkMcpServer({
  name: 'ledung', version: '1.0.0', tools: [
    tool('message_manager', opts.description ?? 'Send a message to another manager.', {
      id: z.string(), text: z.string(),
      ...(opts.attachments ? { attachments: z.array(z.string()).optional() } : {}),
    }, async () => ({ content: [] })),
  ],
});

test('the fingerprint is the same for the same tools, and differs for a new parameter or a changed description', async () => {
  const before = await toolSchemaHash(server());
  assert.match(before, /^[0-9a-f]{16}$/);
  assert.equal(await toolSchemaHash(server()), before, 'two servers with the same tools');
  assert.notEqual(await toolSchemaHash(server({ attachments: true })), before, 'a new parameter (attachments, issue #164)');
  assert.notEqual(await toolSchemaHash(server({ description: 'Send a message, with files.' })), before, 'a changed description');
});

function setup() {
  const store = new Store(openDatabase(':memory:'));
  const management = new Management({
    store, userName: 'Simon', publish: () => {}, wake: () => {}, resume: async () => {},
    startSession: async () => { throw new Error('not used'); },
    stopSession: async () => {}, archiveSession: () => {}, projectNames: () => ['p'], decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, handoffProblem: () => null, shotPath: (_id, file) => file,
    projects: () => [], addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); },
  });
  let n = 0;
  /** A session's options as Ledung hands them to the SDK: a new start, or a reattach to a running host. */
  const options = async (attachTo?: string, id = `s${++n}`) => {
    const info = store.getSession(id) ?? store.createSession({ id, project: 'p', runner: 'local', title: 'worker', parentId: null, permissionMode: 'default' });
    const session = new Session({
      info, store, publish: () => {}, userName: 'Simon', management, workflow: null,
      runner: { cwd: process.cwd(), currentBranch: async () => null } as never,
      gate: { mayStart: () => true, started: () => {}, ended: () => {} },
      ...(attachTo ? { attachTo } : {}),
    });
    const o = await session.claudeOptions({ onLine: () => {}, onStderr: () => {} });
    const signal = { signal: new AbortController().signal };
    const after = async (kind: 'PostToolUse' | 'PostToolUseFailure', toolName: string) => {
      const out = await o.hooks![kind]![0]!.hooks[0]!({ hook_event_name: kind, tool_name: toolName, tool_use_id: `t${++n}`, error: 'x' } as never, undefined, signal);
      return (out as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;
    };
    /** Connects Ledung's server as the SDK does, and returns what the server sent Claude Code on its own. */
    const connect = async () => {
      const sent: { method?: string }[] = [];
      const instance = (o.mcpServers!.ledung as { instance: { connect(t: unknown): Promise<void> } }).instance;
      await instance.connect({ start: async () => {}, send: async (m: { method?: string }) => { sent.push(m); }, close: async () => {} });
      return sent;
    };
    return { id, after, connect };
  };
  return { store, options };
}

const CHANGED = 'notifications/tools/list_changed';

test('a new start records its tool list; a reattach under the same Ledung tools is told nothing', async () => {
  const { store, options } = setup();
  const started = await options();
  const fingerprint = store.toolsSchema(started.id);
  assert.match(fingerprint ?? '', /^[0-9a-f]{16}$/, 'the start records the list it gives Claude Code');
  assert.deepEqual((await started.connect()).map((m) => m.method), [], 'a new start is not told the tools changed');
  assert.equal(await started.after('PostToolUse', 'mcp__ledung__ask_user'), undefined);

  const reattached = await options('host-1', started.id);
  assert.deepEqual((await reattached.connect()).map((m) => m.method), [], 'same tools: no notification');
  assert.equal(await reattached.after('PostToolUse', 'mcp__ledung__ask_user'), undefined, 'same tools: no note');
  assert.equal(store.toolsSchema(started.id), fingerprint, 'unchanged by the reattach');
});

test('a reattach to a session started under other Ledung tools sends "tools changed" and notes the next Ledung call, once', async () => {
  const { store, options } = setup();
  const started = await options();
  const current = store.toolsSchema(started.id)!;
  // The session's Claude Code was started under the Ledung before the release.
  store.setToolsSchema(started.id, '0000000000000000');
  const reattached = await options('host-1', started.id);
  assert.deepEqual((await reattached.connect()).map((m) => m.method), [CHANGED], 'told the tools changed, once it is connected');
  assert.equal(await reattached.after('PostToolUse', 'Bash'), undefined, 'not after a call that is not Ledung\'s');
  assert.equal(await reattached.after('PostToolUse', 'mcp__ledung__list_sessions'), STALE_TOOLS_NOTE, 'after its next Ledung call');
  assert.match(STALE_TOOLS_NOTE, /restart this session to get the new tools/, "Martin's words");
  assert.equal(await reattached.after('PostToolUse', 'mcp__ledung__list_sessions'), undefined, 'once, not after every call');
  // The notification brings Claude Code new tools, not changed ones (the PR's loopback finding): the record stays.
  assert.equal(store.toolsSchema(started.id), '0000000000000000');
  // A resume is a new Claude Code process, with the current list.
  const resumed = await options(undefined, started.id);
  assert.equal(store.toolsSchema(started.id), current);
  assert.equal(await resumed.after('PostToolUse', 'mcp__ledung__list_sessions'), undefined);
});

test('a refused Ledung call notes it too, and a session from before #164 (no record) counts as old', async () => {
  const { store, options } = setup();
  const id = 'before-164';
  store.createSession({ id, project: 'p', runner: 'local', title: 'worker', parentId: null, permissionMode: 'default' });
  assert.equal(store.toolsSchema(id), null, 'no record, as a session started before this release has');
  const reattached = await options('host-1', id);
  assert.deepEqual((await reattached.connect()).map((m) => m.method), [CHANGED]);
  // The issue's evidence: the new parameter arrives as a string and the call is refused.
  assert.equal(await reattached.after('PostToolUseFailure', 'mcp__ledung__message_manager'), STALE_TOOLS_NOTE);
});
