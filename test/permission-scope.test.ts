// "Allow for this session" from the page is saved and applied as this session, not once (issue #170).
// The real server, session manager and session share one store; only Claude Code is left out (the
// session's permission callback is called directly, as in sensitive-via-manager.test.ts).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { Session } from '../src/sessions/session.ts';
import { Away } from '../src/sessions/away.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

const PORT = await freePort();
const TOKEN = 'c'.repeat(64);
const ORIGIN = `http://127.0.0.1:${PORT}`;

type Callback = (tool: string, input: Record<string, unknown>, opts: { signal: AbortSignal; toolUseID?: string }) => Promise<PermissionResult>;

let server: LedungServer;
let store: Store;
let onPermission: Callback;
let projectRoot: string;

before(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-scope-'));
  const webRoot = path.join(projectRoot, 'web');
  fs.mkdirSync(webRoot);
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
  store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port: PORT, projects: [{ name: 'p', runner: 'local', path: projectRoot }] }), store, () => {}));
  const internals = manager as unknown as { live: Map<string, Session>; management: ConstructorParameters<typeof Session>[0]['management'] };
  const info = store.createSession({ id: 's1', project: 'p', runner: 'local', title: 't', parentId: null, permissionMode: 'default', role: 'session' });
  const session = new Session({
    info, store, publish: () => {}, userName: 'Simon', management: internals.management,
    away: new Away(store, () => {}),
    runner: { cwd: '.', currentBranch: async () => null } as never,
    gate: { mayStart: () => true, started: () => {}, ended: () => {} },
  });
  internals.live.set('s1', session);
  onPermission = (session as unknown as { onPermission: Callback }).onPermission.bind(session);
  server = new LedungServer({ port: PORT, token: TOKEN, store, manager, webRoot });
  await server.listen();
});

after(async () => {
  await server.close();
  removeTemp(projectRoot);
});

const decide = (id: string, body: unknown) => fetch(`${ORIGIN}/api/permissions/${id}`, {
  method: 'POST',
  headers: { cookie: `ledung_auth=${TOKEN}`, origin: ORIGIN, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** A request as Claude Code makes it; resolves with Ledung's answer, or stays pending while it is asked. */
function ask(command: string) {
  let result: PermissionResult | undefined;
  void onPermission('Bash', { command }, { signal: new AbortController().signal }).then((r) => { result = r; });
  return { pending: () => store.pendingPermissions().at(-1), result: async () => { await new Promise((r) => setImmediate(r)); return result; } };
}

test('"Allow for this session" from the page is recorded as session and covers the repeats', async () => {
  const first = ask('npm run lint');
  const p = first.pending()!;
  assert.deepEqual(p.input, { command: 'npm run lint' });
  const res = await decide(p.id, { behavior: 'allow', scope: 'session' });
  assert.equal(res.status, 200, await res.text());
  assert.equal(store.getPermission(p.id)!.scope, 'session', 'the permissions record says session');
  const allowed = await first.result();
  assert.equal(allowed?.behavior, 'allow');
  assert.ok(allowed?.behavior === 'allow' && allowed.updatedPermissions?.length, 'Claude Code is told to allow it for the session');

  // The same request again is allowed without a prompt.
  const before = store.pendingPermissions().length;
  const repeat = ask('npm run lint');
  assert.equal((await repeat.result())?.behavior, 'allow');
  assert.equal(store.pendingPermissions().length, before, 'nobody was asked again');
});

test('a plain allow from the page stays once, and the repeat is asked again', async () => {
  const first = ask('npm run fmt');
  const p = first.pending()!;
  assert.equal((await decide(p.id, { behavior: 'allow' })).status, 200);
  assert.equal(store.getPermission(p.id)!.scope, 'once');
  const repeat = ask('npm run fmt');
  assert.equal(await repeat.result(), undefined, 'asked again');
  assert.notEqual(repeat.pending()!.id, p.id);
});
