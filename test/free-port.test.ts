import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { freePort, isBadFetchPort, listenOk } from './free-port.ts';

test('freePort skips a port on fetch\'s blocked list and returns the next good one', async () => {
  const offered = [6000, 6667, 40001];
  const port = await freePort(async () => offered.shift()!);
  assert.equal(port, 40001);
  assert.deepEqual(offered, []);
});

test('the blocked list has its range ends and leaves the neighbours alone', () => {
  for (const p of [6665, 6669, 10080, 4190, 6697]) assert.ok(isBadFetchPort(p), String(p));
  for (const p of [6664, 6670, 10081, 8080]) assert.ok(!isBadFetchPort(p), String(p));
});

test('listenOk leaves the server listening on a port fetch can reach', async () => {
  const server = net.createServer();
  const port = await listenOk(server);
  assert.ok(!isBadFetchPort(port));
  assert.equal((server.address() as net.AddressInfo).port, port);
  await new Promise((r) => server.close(r));
});
