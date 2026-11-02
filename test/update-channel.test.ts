// Settings → About's update channel (issue #461; Martin, 2026-11-02 00:38, Ledung question #1172): Public by default;
// on an npm install the check and Update Ledung follow npm's `latest` on Public and `dev` on Dev; a clone release
// keeps updating from main whatever the channel. npm itself is replaced by small node commands.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NPM_DEV_REASON, NPM_REASON, Updater, type Command, type UpdaterOptions } from '../src/update/updater.ts';
import type { UpdateView } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';
import { WAIT_MS } from './limits.ts';

let base: string;
before(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-channel-')); });
after(() => removeTemp(base));

/** What `npm view ledung dist-tags --json` answers. */
const tags = (t: Record<string, string>): Command => ({ cmd: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify(t))})`] });
const NPM_TAGS = { latest: '1.0.0', dev: '1.2.0' };

function memoryMeta() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), map: m };
}

function npmUpdater(extra: Partial<UpdaterOptions> = {}) {
  const installs: string[] = [];
  let restarts = 0;
  const meta = memoryMeta();
  const u = new Updater({
    appDir: path.join(base, 'pkg'), dataDir: base, configPath: path.join(base, 'c.json'), npmVersion: '1.0.0', meta,
    onRestart: () => { restarts++; },
    distTags: tags(NPM_TAGS),
    npmInstall: (spec) => { installs.push(spec); return { cmd: process.execPath, args: ['-e', `console.log("added 1 package")`] }; },
    ...extra,
  });
  return { u, meta, installs, restarts: () => restarts };
}

async function settled(u: Updater): Promise<UpdateView> {
  for (const end = Date.now() + WAIT_MS; Date.now() < end;) {
    const v = u.view();
    if (!v.updating) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('the update did not finish');
}

/** Waits past the restart's 1.5 s delay. */
const afterRestartDelay = () => new Promise((r) => setTimeout(r, 1700));

test('the channel is Public until Dev is chosen, is kept in the meta table, and a bad one is refused', () => {
  const { u, meta } = npmUpdater();
  assert.equal(u.view().channel, 'public');
  assert.equal(u.view().reason, NPM_REASON);
  assert.equal(u.setChannel('dev').channel, 'dev');
  assert.equal(meta.map.get('update-channel'), 'dev');
  assert.equal(u.view().reason, NPM_DEV_REASON, 'the manual way names ledung@dev');
  assert.throws(() => u.setChannel('latest' as never), /public or dev/);
  assert.equal(u.setChannel('public').channel, 'public');
  // Without a place to keep it, there is no choice to make.
  assert.throws(() => new Updater({ appDir: base, dataDir: base, configPath: 'c', npmVersion: '1.0.0' }).setChannel('dev'), /cannot be kept/);
});

test("on Public the npm check offers latest, on Dev the dev build; switching channel drops the other channel's check", async () => {
  const { u } = npmUpdater();
  const pub = await u.checkForUpdates();
  assert.equal(pub.checkError, null);
  assert.deepEqual({ ...pub.npmCheck, checkedAt: '' }, { checkedAt: '', channel: 'public', offered: '1.0.0', upToDate: true });
  assert.equal(pub.check, null, 'no git check on an npm install');
  assert.equal(u.setChannel('dev').npmCheck, null);
  const dev = await u.checkForUpdates();
  assert.deepEqual({ ...dev.npmCheck, checkedAt: '' }, { checkedAt: '', channel: 'dev', offered: '1.2.0', upToDate: false });
});

test('a failing or nonsense answer from npm is a check error, not a crash', async () => {
  const failing = npmUpdater({ distTags: { cmd: process.execPath, args: ['-e', 'console.error("npm ERR! code E404"); process.exit(1)'] } }).u;
  assert.match((await failing.checkForUpdates()).checkError ?? '', /dist-tags failed[\s\S]*E404/);
  const garbled = npmUpdater({ distTags: { cmd: process.execPath, args: ['-e', 'console.log("not json")'] } }).u;
  assert.match((await garbled.checkForUpdates()).checkError ?? '', /did not answer with its tags/);
});

test('Update Ledung on Dev installs the exact dev version with npm, then restarts', async () => {
  const { u, installs, restarts } = npmUpdater();
  u.setChannel('dev');
  assert.equal(u.runUpdate().updating, true);
  const v = await settled(u);
  assert.equal(v.refused, null);
  assert.deepEqual(installs, ['ledung@1.2.0']);
  assert.deepEqual(v.steps.map((s) => [s.label, s.state]), [
    ['Ask npm for the Dev version', 'done'],
    ['npm install -g ledung@1.2.0', 'done'],
    ['Restart Ledung', 'running'],
  ]);
  assert.equal(v.restarting, true);
  await afterRestartDelay();
  assert.equal(restarts(), 1);
});

test('on Public with latest already installed, Update installs nothing and does not restart', async () => {
  const { u, installs, restarts } = npmUpdater();
  u.runUpdate();
  const v = await settled(u);
  assert.match(v.refused ?? '', /v1 is already the newest on this channel\. The running Ledung was not changed\./);
  assert.deepEqual(installs, []);
  assert.equal(v.steps[0]!.state, 'failed');
  await afterRestartDelay();
  assert.equal(restarts(), 0);
});

test('a Dev build switched to Public is never taken down to the older public release', async () => {
  const { u, installs } = npmUpdater({ npmVersion: '1.2.0' });
  assert.equal((await u.checkForUpdates()).npmCheck?.upToDate, true);
  u.runUpdate();
  assert.match((await settled(u)).refused ?? '', /already the newest/);
  assert.deepEqual(installs, []);
});

test('a failed npm install leaves the running Ledung alone', async () => {
  const { u, restarts } = npmUpdater({ npmInstall: () => ({ cmd: process.execPath, args: ['-e', 'console.error("npm ERR! code EACCES"); process.exit(243)'] }) });
  u.setChannel('dev');
  u.runUpdate();
  const v = await settled(u);
  assert.match(v.refused ?? '', /npm install -g ledung@1\.2\.0 failed \(exit code 243\)\. The running Ledung was not changed\./);
  assert.match(v.steps[1]!.output ?? '', /EACCES/);
  await afterRestartDelay();
  assert.equal(restarts(), 0);
  assert.equal(v.restarting, false);
});

test('without the ledung command to restart it, an npm update is refused before anything runs', () => {
  const { u, installs } = npmUpdater({ onRestart: undefined });
  const v = u.runUpdate();
  assert.equal(v.updating, false);
  assert.match(v.refused ?? '', /not started by the ledung command/);
  assert.deepEqual(installs, []);
});

test('a clone release keeps its git update whatever the channel: npm is never asked', async () => {
  const app = path.join(base, 'release');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'release.json'), JSON.stringify({ source: path.join(base, 'no-clone'), commit: 'abc' }));
  let asked = 0;
  const meta = memoryMeta();
  const u = new Updater({ appDir: app, dataDir: base, configPath: 'c', meta, distTags: { cmd: process.execPath, args: ['-e', ''] }, npmInstall: () => { asked++; return { cmd: 'x', args: [] }; } });
  u.setChannel('dev');
  const v = await u.checkForUpdates();
  assert.equal(v.available, true);
  assert.equal(v.npmCheck, null);
  // The git check ran (and found no clone), not npm's.
  assert.match(v.checkError ?? '', /not a git clone/);
  assert.equal(asked, 0);
});
