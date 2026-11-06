// #157: the two endpoints that show stored turns must hold their CPU figures at this machine's thread
// count. The functions are covered in cpu-sample.test.ts; this drives the server, so a dropped thread
// count or a dropped cap on either route fails here (PR #155 test review, finding 1).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import type { TurnResource, TypicalCost } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort } from './free-port.ts';

const TOKEN = 'c'.repeat(64);
const COOKIE = `ledung_auth=${TOKEN}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-cpu-turns-'));
const webRoot = path.join(dir, 'web');
fs.mkdirSync(webRoot);
fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Ledung</title>');
after(() => removeTemp(dir));

test('both turn endpoints hold a stored peak above the thread count at it, and leave one below as it is', async () => {
  const threads = os.cpus().length;
  const port = await freePort();
  const db = openDatabase(path.join(dir, 'ledung.db'));
  const store = new Store(db);
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));
  const server = new LedungServer({ port, token: TOKEN, store, manager, webRoot });
  await server.listen();
  try {
    const turn = (startedAt: number, cpuSeconds: number, peakCores: number) => ({
      sessionId: 's1', project: 'p', role: 'session', model: null, trigger: 'user', startedAt, durationMs: 10_000,
      cpuSeconds, avgCores: 0, peakCores, peakMem: 1e9, samples: 5, commands: ['npm run check'],
    });
    store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'Busy turns', parentId: null, permissionMode: 'default' });
    // avgCores is not stored: the store reads it back as CPU seconds over the duration.
    // A turn recorded before the fix: peak twice the thread count plus one, and an average just as high
    // (CPU seconds over its 10 s). And one well inside the limit: peak 0.5, average 0.25.
    const now = Date.now();
    store.addTurnResource(turn(now - 60_000, (2 * threads + 1) * 10, 2 * threads + 1));
    store.addTurnResource(turn(now - 30_000, 2.5, 0.5));

    const get = async <T>(p: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/${p}`, { headers: { cookie: COOKIE } });
      assert.equal(res.status, 200, p);
      return (await res.json()) as T;
    };

    const turns = await get<TurnResource[]>('sessions/s1/turns');
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.peakCores, threads);
    assert.equal(turns[0]!.avgCores, threads);
    // Positive branch: the turn inside the limit comes back unchanged.
    assert.equal(turns[1]!.peakCores, 0.5);
    assert.equal(turns[1]!.avgCores, 0.25);

    const typical = await get<TypicalCost[]>('typical-costs');
    const row = typical.find((c) => c.command === 'npm run check');
    assert.ok(row, JSON.stringify(typical));
    // The mean of the two peaks with the first held at the thread count, not (2 × threads + 1 + 0.5) / 2.
    assert.equal(row.peakCores, (threads + 0.5) / 2);
  } finally {
    await server.close();
    db.close();
  }
});
