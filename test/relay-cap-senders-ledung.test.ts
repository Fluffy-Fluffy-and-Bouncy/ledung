// A capped owner's sends to the admin's own computers (issue #176), Ledung's side: the admin's Ledung tells the relay
// which linked computer each request through the tunnel comes from, found from the linked key before the body is read,
// and refuses to keep a file from a computer the relay names as capped, with the sentence that says so; messages
// without files still go. Two real Ledungs linked over their tunnels with TLS ending in each, as in
// relay-cap-ledung.test.ts; the relay's side (the throttle, the capped hosts) is relay-cap-senders.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Management } from '../src/sessions/management.ts';
import { relayCapSenderSentence } from '../src/remote/tunnel.ts';
import { LinkedNodes, type Node } from './linked-nodes.ts';
import { removeTemp } from './temp.ts';
import { HANG_MS } from './limits.ts';

const nodes = new LinkedNodes();
const temps: string[] = [];
after(async () => {
  await nodes.close();
  for (const t of temps) removeTemp(t);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(100)]);
const temp = (what: string) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ledung-capsend-${what}-`)));
  temps.push(dir);
  return dir;
};
const management = (n: Node) => (n.manager as unknown as { management: Management }).management;
const copies = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(png|jpg|txt)$/.test(f)) : []);
/** What the tunnel hands the server when the relay names capped senders, or none. */
const cappedSenders = (n: Node, hosts: string[] | null) => n.server.setRemote({ state: 'connected', publicName: n.name, error: null, ...(hosts ? { cappedSenders: { hosts, resetsOn: '2026-12-01' } } : {}) });

test('relayCapSenderSentence says the sending computer\'s owner is past the limit and the day it resets', () => {
  assert.equal(relayCapSenderSentence('2026-12-01'), 'Not kept: the relay\'s monthly limit for the sending computer\'s owner is reached; it resets on 1 December 2026. Messages without files still go through.');
});

test('ledung#176: the admin\'s Ledung tells the relay who each linked request comes from, and refuses a capped sender\'s file with the sentence; messages still go', { timeout: HANG_MS }, async () => {
  const alpha = temp('alpha');
  const common = { userName: 'Martin', browseRoots: [os.tmpdir()] };
  // "bob" is the capped owner's computer, "mine" the admin's own.
  const bob = await nodes.ledung('bob-cap.files.test', undefined, undefined, undefined, { ...common, projects: [{ name: 'Alpha', runner: 'local', path: alpha }] });
  const mine = await nodes.ledung('mine-cap.files.test', undefined, undefined, undefined, { ...common, projects: [{ name: 'Beta', runner: 'local', path: temp('beta') }] });
  const mineFiles = temp('mine-linked');
  mine.manager.linkedFilesDir = () => mineFiles;
  bob.manager.linkedFilesDir = () => temp('bob-linked');
  // What the admin's Ledung tells the relay, per stream, as its tunnel would carry it (tunnel.ts open).
  const told: string[] = [];
  const connection = mine.server.tunnelConnection.bind(mine.server);
  mine.server.tunnelConnection = () => connection((host) => told.push(host));
  await nodes.link(bob, mine, 'Bob');
  for (const [n, id, project] of [[bob, 'bob-alpha', 'Alpha'], [mine, 'mine-beta', 'Beta']] as const) {
    n.store.createSession({ id, project, runner: 'local', title: `Manager: ${project}`, parentId: null, permissionMode: 'default', role: 'manager' });
    n.store.updateSession(id, { status: 'idle' });
  }
  fs.writeFileSync(path.join(alpha, 'shot.png'), PNG);
  const toMine = (text: string, files?: string[]) => management(bob).messageComputerManager('bob-alpha', 'mine-cap', 'mine-beta', text, files);

  // Uncapped: told who the request is from, and the file is kept. The positive branch of both checks below.
  told.length = 0;
  assert.match(await toMine('with a file', ['shot.png']), /With 1 file\(s\): shot\.png/);
  assert.equal(copies(mineFiles).length, 1, 'kept');
  assert.ok(told.length > 0 && told.every((h) => h === 'bob-cap.files.test'), `the relay is told the linked computer's public name (${told.join(', ')})`);

  // The relay names Bob's computer as capped: his own Ledung isn't capped and sends, the admin's refuses to keep it.
  cappedSenders(mine, ['bob-cap.files.test']);
  told.length = 0;
  await assert.rejects(toMine('with a file', ['shot.png']), (e: Error) => e.message.endsWith(`answered 429: ${relayCapSenderSentence('2026-12-01')}`) || assert.fail(e.message));
  assert.equal(copies(mineFiles).length, 1, 'nothing more kept');
  assert.ok(told.includes('bob-cap.files.test'), 'and the relay was told who sent it, so it holds the stream');
  const before = mine.store.undeliveredInbox('mine-beta').length;
  assert.match(await toMine('just text'), /^Sent to manager "Manager: Beta"/);
  assert.equal(mine.store.undeliveredInbox('mine-beta').length, before + 1, 'a message without files still goes');

  // Another computer named as capped: Bob's file is kept again.
  cappedSenders(mine, ['someone-else.files.test']);
  assert.match(await toMine('with a file', ['shot.png']), /With 1 file\(s\): shot\.png/);
  assert.equal(copies(mineFiles).length, 2);
});
