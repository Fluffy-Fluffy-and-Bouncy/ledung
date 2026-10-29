// Managers on linked computers (issue #245, docs/steps/manager-link.md step 2): list_managers, message_manager and
// list_projects across two computers, trusted as this computer's own, with lockdown as on one computer and the
// limits on waking. The link itself is a stand-in here that calls the other computer's side as /link/* does;
// test/linked.test.ts covers the real route and its locks, the loopback the whole path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { LINK_BURST_MS, LINK_MAX_CHARS, LINK_SENDS_PER_HOUR, LINK_WAKES_PER_HOUR, Management, ManagementError, type LinkedMessage, type LinkedPort } from '../src/sessions/management.ts';
import { buildDelivery } from '../src/sessions/management.ts';
import type { ProjectInfo } from '../src/shared/protocol.ts';

const info = (name: string, level: 'off' | 'A' | 'B', managerId: string | null): ProjectInfo => ({
  name, runner: 'local', where: `/home/${name}`, path: `/home/${name}`, account: null, model: 'haiku', managerModel: null, permissionMode: 'auto', managerGrant: null,
  projectToolsUnasked: false, sensitive: { commandPatterns: [], pathPatterns: [], mcpTools: [] }, devShipCommand: null, tickets: null, questionTiers: [],
  extraFolders: [], profiles: { manager: null, session: null }, skills: {}, workflow: null, managerId, createdAt: 0, colours: { manager: null, sessions: 'same' },
  lockdown: { level, board: false, remoteControl: false },
});

interface Side { m: Management; store: Store; woken: string[]; offline: boolean; port: LinkedPort | null; clock: { now: number } }

/** One computer with managers for `projects` ([name, level]), each manager id "<computer>-<project>". */
function computer(name: string, projects: [string, 'off' | 'A' | 'B'][], clock: { now: number }): Side {
  const store = new Store(openDatabase(':memory:'));
  const infos = projects.map(([p, level]) => info(p, level, `${name}-${p}`));
  const side: Side = { m: null as never, store, woken: [], offline: false, port: null, clock };
  side.m = new Management({
    store, userName: 'Martin', publish: () => {}, wake: (id) => void side.woken.push(id), resume: async () => {},
    startSession: async () => { throw new Error('not used'); }, stopSession: async () => {}, archiveSession: () => {},
    projectNames: () => infos.map((p) => p.name), decidePermission: () => true,
    machine: () => ({ at: 0, cpus: 8, cores: 1, memTotal: 16e9, memUsed: 8e9, docker: null, sessions: {}, working: 1, limit: 10, line: [] }),
    setPriority: () => {}, setPaused: () => {}, projects: () => infos,
    addProject: () => { throw new Error('not used'); }, createProject: async () => { throw new Error('not used'); },
    ensureManager: async () => { throw new Error('not used'); }, handoffProblem: () => null, shotPath: (_id, f) => f,
    now: () => clock.now, linked: () => side.port,
  });
  for (const [p] of projects) {
    store.createSession({ id: `${name}-${p}`, project: p, runner: 'local', title: `Manager: ${p}`, parentId: null, permissionMode: 'default', role: 'manager' });
    store.updateSession(`${name}-${p}`, { status: 'idle' });
  }
  return side;
}

/** Links two computers as /link/* would: each knows the other by a name and a link id of its own. */
function link(a: Side, aName: string, b: Side, bName: string): void {
  const port = (self: Side, other: Side, otherName: string, selfAsSeen: { id: string; name: string }): LinkedPort => ({
    list: () => [{ id: `link-to-${otherName}`, name: otherName, publicName: `${otherName.toLowerCase()}.l.test`, linkedAt: 0, lastUsedAt: null }],
    callLinked: async (_id, route, body) => {
      if (other.offline) throw new Error(`${otherName.toLowerCase()}.l.test is offline (its Ledung is not connected to the relay).`);
      try {
        if (route === '/link/managers') return { text: other.m.managersForComputer() };
        if (route === '/link/projects') return { text: other.m.projectsForComputer() };
        if (route === '/link/message') return { text: other.m.fromComputer(selfAsSeen, body as unknown as LinkedMessage) };
      } catch (e) {
        if (e instanceof ManagementError) throw new Error(`${otherName.toLowerCase()}.l.test answered 400: ${e.message}`);
        throw e;
      }
      throw new Error(`no route ${route}`);
    },
  });
  a.port = port(a, b, bName, { id: `link-to-${aName}`, name: aName });
  b.port = port(b, a, aName, { id: `link-to-${bName}`, name: bName });
}

const inbox = (s: Side, id: string) => s.store.undeliveredInbox(id);

function pair(macProjects: [string, 'off' | 'A' | 'B'][] = [['Ledung', 'off']], pcProjects: [string, 'off' | 'A' | 'B'][] = [['WebInfra', 'off']]) {
  const clock = { now: 1_000_000 };
  const mac = computer('mac', macProjects, clock);
  const pc = computer('pc', pcProjects, clock);
  link(mac, 'Mac', pc, 'PC');
  return { mac, pc, clock };
}

test('with no linked computer, list_managers is what it always was', async () => {
  const clock = { now: 0 };
  const alone = computer('mac', [['Ledung', 'off'], ['Other', 'off']], clock);
  assert.equal(await alone.m.listManagersEverywhere('mac-Ledung'), alone.m.listManagers('mac-Ledung'));
  await assert.rejects(alone.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', 'hi'), /linked with no other computer/);
});

test('list_managers shows every computer\'s managers, each under its computer; an offline one says so', async () => {
  const { mac, pc } = pair([['Ledung', 'off'], ['Docs', 'off']], [['WebInfra', 'off'], ['Secret', 'A']]);
  const all = await mac.m.listManagersEverywhere('mac-Ledung');
  assert.match(all, /^On this computer:\n- "Manager: Docs" \(mac-Docs\) for Docs: idle/);
  // The PC's part, its lines in whatever order its store lists them (created in the same millisecond here).
  const onPc = all.split('\n\n').find((p) => p.startsWith('On your computer "PC" (give message_manager computer "PC"):\n'));
  assert.ok(onPc, all);
  assert.deepEqual(onPc.split('\n').slice(1).sort(), [
    '- "Manager: WebInfra" (pc-WebInfra) for WebInfra: idle',
    "- Secret: locked; its manager can't be reached from other projects",
  ]);
  assert.doesNotMatch(all, /pc-Secret/, 'a locked project is named only, as on one computer');
  assert.equal(await mac.m.listManagersEverywhere('mac-Ledung', 'pc'), (await mac.m.listManagersEverywhere('mac-Ledung', 'PC')));
  await assert.rejects(mac.m.listManagersEverywhere('mac-Ledung', 'Laptop'), /"Laptop" is not a linked computer\. Linked: "PC"/);

  pc.offline = true;
  assert.match(await mac.m.listManagersEverywhere('mac-Ledung'), /On your computer "PC": pc\.l\.test is offline/);
  assert.match(await mac.m.listProjectsOn('mac-Ledung'), /"Ledung" \(yours\)/, 'list_projects without a computer is this one\'s');
  pc.offline = false;
  const projects = await mac.m.listProjectsOn('mac-Ledung', 'PC');
  assert.match(projects, /Projects on your computer "PC":\n- "WebInfra": manager "Manager: WebInfra" \(pc-WebInfra\) idle\n- "Secret": locked/);
  assert.doesNotMatch(projects, /\/home\//, 'no folders leave the computer');
});

test('a message wakes the manager on the other computer, marked as a local one is plus where to answer, never as Martin\'s words', async () => {
  const { mac, pc } = pair();
  const out = await mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', 'Please run the tests on Windows.');
  assert.equal(out, 'Sent to manager "Manager: WebInfra". (on your computer "PC")');
  assert.deepEqual(pc.woken, ['pc-WebInfra']);
  const [item] = inbox(pc, 'pc-WebInfra');
  assert.equal(item!.source, 'manager:link-to-Mac/mac-Ledung', 'a manager\'s message, so it counts as one (turn trigger)');
  assert.equal(item!.text, 'Message from manager "Manager: Ledung" (mac-Ledung) of Ledung on your computer "Mac":\n\nPlease run the tests on Windows.\n\n(Answer with message_manager to mac-Ledung, computer "Mac".)');
  // Delivered in the context part, behind the sentence that it is not Martin's, as every manager's message.
  const d = buildDelivery('Martin', [], [item!], () => '');
  assert.match(d.userText, /not from Martin/);
  assert.doesNotMatch(d.userText, /run the tests/);
  assert.match(d.context, /run the tests/);

  // The answer comes back the same way.
  await pc.m.messageComputerManager('pc-WebInfra', 'Mac', 'mac-Ledung', 'Green on Windows.');
  assert.match(inbox(mac, 'mac-Ledung')[0]!.text, /^Message from manager "Manager: WebInfra" \(pc-WebInfra\) of WebInfra on your computer "PC":\n\nGreen on Windows\./);
});

test('as on one computer: an ended manager gets nothing, a wrong id is refused, and the reason comes back', async () => {
  const { mac, pc } = pair();
  await assert.rejects(mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-Nobody', 'hi'), /pc-Nobody is not a manager there/);
  pc.store.updateSession('pc-WebInfra', { status: 'ended' });
  await assert.rejects(mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', 'hi'), /"Manager: WebInfra" of "WebInfra" is not running, so your message was not sent/);
  assert.deepEqual(inbox(pc, 'pc-WebInfra'), []);
  assert.deepEqual(pc.woken, []);
  pc.offline = true;
  await assert.rejects(mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', 'hi'), /pc\.l\.test is offline/);
});

test('lockdown holds across computers as on one: a locked project can\'t be messaged, may write, and gets one answer per message', async () => {
  const { mac, pc } = pair([['Ledung', 'off'], ['Island', 'A']], [['WebInfra', 'off'], ['Fort', 'A'], ['Bunker', 'B']]);
  await assert.rejects(mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-Fort', 'hi'), /"Fort" is locked: managers of other projects can't message it/);
  await assert.rejects(mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-Bunker', 'hi'), /lockdown level B/);

  // Island (locked, on the Mac) writes to the PC; the PC's manager may answer once.
  await mac.m.messageComputerManager('mac-Island', 'PC', 'pc-WebInfra', 'Need the server log.');
  assert.match(inbox(pc, 'pc-WebInfra')[0]!.text, /its project is locked\. You can answer this message once, with message_manager to mac-Island on computer "Mac"/);
  await pc.m.messageComputerManager('pc-WebInfra', 'Mac', 'mac-Island', 'Here it is.');
  assert.match(inbox(mac, 'mac-Island')[0]!.text, /^Reply from manager "Manager: WebInfra" \(pc-WebInfra\) of WebInfra on your computer "PC", to your message:\n\nHere it is\./);
  await assert.rejects(pc.m.messageComputerManager('pc-WebInfra', 'Mac', 'mac-Island', 'And more.'), /"Island" is locked/, 'only once');

  // Level B has no tools for other managers at all.
  assert.throws(() => pc.m.listManagers('pc-Bunker'), /level B/);
  await assert.rejects(pc.m.listManagersEverywhere('pc-Bunker'), /level B/);
  await assert.rejects(pc.m.messageComputerManager('pc-Bunker', 'Mac', 'mac-Ledung', 'hi'), /level B/);
});

test('waking across computers is capped: bursts become one wake, six an hour per pair, then quiet with one note', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { mac, pc, clock } = pair([['Ledung', 'off'], ['Docs', 'off']]);
  // Three messages within the burst: one wake now, one when the burst ends.
  for (const n of [1, 2, 3]) await mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', `burst ${n}`);
  assert.deepEqual(pc.woken, ['pc-WebInfra']);
  t.mock.timers.tick(LINK_BURST_MS);
  assert.deepEqual(pc.woken, ['pc-WebInfra', 'pc-WebInfra']);
  assert.equal(inbox(pc, 'pc-WebInfra').length, 3, 'every message arrives');

  // Spaced out: wakes until six in the hour for this pair.
  for (let i = 0; i < 6; i++) {
    clock.now += LINK_BURST_MS + 1;
    await mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', `spaced ${i}`);
  }
  assert.equal(pc.woken.length, LINK_WAKES_PER_HOUR);
  const notes = inbox(pc, 'pc-WebInfra').filter((i) => i.source === 'ledung');
  assert.equal(notes.length, 1);
  assert.match(notes[0]!.text, /has woken you 6 times this hour/);
  clock.now += LINK_BURST_MS + 1;
  await mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', 'one more');
  assert.equal(inbox(pc, 'pc-WebInfra').filter((i) => i.source === 'ledung').length, 1, 'the note once an hour');
  // Another manager on the Mac is another pair.
  clock.now += LINK_BURST_MS + 1;
  await mac.m.messageComputerManager('mac-Docs', 'PC', 'pc-WebInfra', 'from Docs');
  assert.equal(pc.woken.length, LINK_WAKES_PER_HOUR + 1);
  // An hour later the pair wakes again.
  clock.now += 3600_000;
  await mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', 'next hour');
  assert.equal(pc.woken.length, LINK_WAKES_PER_HOUR + 2);
});

test('a manager may send 20 messages an hour to other computers; a long one is refused by the sender, cut by the receiver', async () => {
  const { mac, pc, clock } = pair();
  for (let i = 0; i < LINK_SENDS_PER_HOUR; i++) await mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', `m${i}`);
  await assert.rejects(mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', 'too many'), /20 messages to other computers in the last hour/);
  clock.now += 3600_001;
  // Too long: refused by the sender with the limit and what to do, nothing sent (review 254, Minor 3).
  const before = inbox(pc, 'pc-WebInfra').length;
  await assert.rejects(mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', 'x'.repeat(LINK_MAX_CHARS + 10)),
    /Not sent: a message to another computer is at most 4000 characters, and this one has 4010\. Split it into parts/);
  assert.equal(inbox(pc, 'pc-WebInfra').length, before);
  await mac.m.messageComputerManager('mac-Ledung', 'PC', 'pc-WebInfra', 'x'.repeat(LINK_MAX_CHARS));
  assert.doesNotMatch(inbox(pc, 'pc-WebInfra').at(-1)!.text, /cut by Ledung/, 'at the limit: whole');
  // A sender that doesn't check (another Ledung's version) is cut by the receiver, with a note.
  pc.m.fromComputer({ id: 'link-to-Mac', name: 'Mac' }, { fromId: 'mac-Ledung', fromTitle: 'Manager: Ledung', fromProject: 'Ledung', fromLocked: false, toId: 'pc-WebInfra', text: 'x'.repeat(LINK_MAX_CHARS + 10) });
  assert.match(inbox(pc, 'pc-WebInfra').at(-1)!.text, /\[cut by Ledung: 10 more characters; ask for the rest in parts\]/);
});
