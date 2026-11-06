// The byte cap per owner (issue #161), Ledung's side: a Ledung the relay says is past its owner's monthly cap refuses
// file transfers, sending and receiving, with the sentence that says so and when it resets (Martin, 2026-11-06, Ledung
// question #632); messages without files still go. Two real Ledungs, linked over their tunnels as in
// linked-files.test.ts; the relay's status message reaching the tunnel is test/relay-cap.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Management } from '../src/sessions/management.ts';
import { relayCapSentence } from '../src/remote/tunnel.ts';
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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ledung-cap-${what}-`)));
  temps.push(dir);
  return dir;
};
const management = (n: Node) => (n.manager as unknown as { management: Management }).management;
const copies = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(png|jpg|txt)$/.test(f)) : []);
/** What the tunnel hands the server when the relay's status message says the owner is capped, or not. */
const capped = (n: Node, resetsOn: string | null) => n.server.setRemote({ state: 'connected', publicName: n.name, error: null, ...(resetsOn ? { relayCap: { resetsOn } } : {}) });

test('relayCapSentence says the limit is reached and the day it resets, from the sender\'s side and the receiver\'s', () => {
  assert.equal(relayCapSentence('2026-12-01', true), 'Not sent: your relay\'s monthly limit is reached; it resets on 1 December 2026. Messages without files still go through.');
  assert.equal(relayCapSentence('2027-01-01', false), 'Not kept: the relay\'s monthly limit for this computer\'s owner is reached; it resets on 1 January 2027. Messages without files still go through.');
});

test('ledung#161: a capped Ledung refuses to send a file and to keep one, with the sentence; messages go, and files again once the cap is lifted', { timeout: HANG_MS }, async () => {
  const alpha = temp('alpha');
  const common = { userName: 'Martin', browseRoots: [os.tmpdir()] };
  const mac = await nodes.ledung('mac-cap.files.test', undefined, undefined, undefined, { ...common, projects: [{ name: 'Alpha', runner: 'local', path: alpha }] });
  const pc = await nodes.ledung('pc-cap.files.test', undefined, undefined, undefined, { ...common, projects: [{ name: 'Beta', runner: 'local', path: temp('beta') }] });
  const pcFiles = temp('pc-linked');
  pc.manager.linkedFilesDir = () => pcFiles;
  mac.manager.linkedFilesDir = () => temp('mac-linked');
  await nodes.link(mac, pc, 'Mac');
  for (const [n, id, project] of [[mac, 'mac-alpha', 'Alpha'], [pc, 'pc-beta', 'Beta']] as const) {
    n.store.createSession({ id, project, runner: 'local', title: `Manager: ${project}`, parentId: null, permissionMode: 'default', role: 'manager' });
    n.store.updateSession(id, { status: 'idle' });
  }
  fs.writeFileSync(path.join(alpha, 'shot.png'), PNG);
  const toPc = (text: string, files?: string[]) => management(mac).messageComputerManager('mac-alpha', 'pc-cap', 'pc-beta', text, files);

  // The sender's owner is capped: refused before a byte leaves, the message with it; one without files still goes.
  capped(mac, '2026-12-01');
  await assert.rejects(toPc('with a file', ['shot.png']), (e: Error) => e.message === relayCapSentence('2026-12-01', true));
  assert.deepEqual(copies(pcFiles), [], 'nothing reached the PC');
  assert.deepEqual(pc.store.undeliveredInbox('pc-beta'), [], 'and the message with the file did not go');
  assert.match(await toPc('just text'), /^Sent to manager "Manager: Beta"/);
  assert.equal(pc.store.undeliveredInbox('pc-beta').length, 1, 'a message without files goes through');

  // The receiver's owner is capped: the PC refuses the file with its sentence, which comes back to the sender.
  capped(mac, null);
  capped(pc, '2026-12-01');
  await assert.rejects(toPc('with a file', ['shot.png']), (e: Error) => e.message.endsWith(`answered 429: ${relayCapSentence('2026-12-01', false)}`) || assert.fail(e.message));
  assert.deepEqual(copies(pcFiles), [], 'the PC kept nothing');
  assert.equal(pc.store.undeliveredInbox('pc-beta').length, 1, 'and no second message arrived');
  assert.match(await toPc('text again'), /^Sent to manager "Manager: Beta"/, 'text still goes to a capped computer');

  // The cap lifted (the relay's next status): the same file goes at once. The positive branch of both refusals.
  capped(pc, null);
  assert.match(await toPc('with a file', ['shot.png']), /With 1 file\(s\): shot\.png/);
  assert.equal(copies(pcFiles).length, 1, 'kept on the PC');
});
