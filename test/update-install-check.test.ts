// Issue #435: on Windows, Settings → Update Ledung left 3.11.0 installed and restarted into it, and the page said
// nothing. Update now checks that npm's install reached the folder Ledung runs from before it restarts, remembers the
// version it restarted into so the restarted Ledung can say when it still runs the old one, and logs every outcome.
// npm itself is replaced by small node commands; the folder Ledung "runs from" is a temp folder with a package.json.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Updater, type Command, type UpdaterOptions } from '../src/update/updater.ts';
import { runningVersion } from '../src/platform/paths.ts';
import type { UpdateView } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';
import { WAIT_MS } from './limits.ts';

let base: string;
before(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-install-check-')); });
after(() => removeTemp(base));

const TAGS: Command = { cmd: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify({ latest: '1.0.0', dev: '1.2.0' }))})`] };

/** A stand-in for npm install -g: writes the package.json of `version` into `dir`, prints npm's success line, exits 0. */
function installInto(dir: string, version: string): Command {
  const script = `const fs = require('node:fs'); fs.mkdirSync(${JSON.stringify(dir)}, { recursive: true }); fs.writeFileSync(${JSON.stringify(path.join(dir, 'package.json'))}, JSON.stringify({ name: 'ledung', version: ${JSON.stringify(version)} })); console.log("added 1 package in 2s")`;
  return { cmd: process.execPath, args: ['-e', script] };
}

/** A folder Ledung runs from, holding version 1.0.0, as the npm package's own folder does. */
function appFolder(name: string): string {
  const dir = path.join(base, name, 'node_modules', 'ledung');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ledung', version: '1.0.0' }));
  return dir;
}

function memoryMeta() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => void m.set(k, v), map: m };
}

function updater(appDir: string, extra: Partial<UpdaterOptions> = {}) {
  let restarts = 0;
  const logged: string[] = [];
  const meta = extra.meta ?? memoryMeta();
  const u = new Updater({
    appDir, dataDir: base, configPath: path.join(base, 'c.json'), npmVersion: '1.0.0', meta,
    onRestart: () => { restarts++; },
    distTags: TAGS,
    log: (line) => logged.push(line),
    ...extra,
  });
  meta.set('update-channel', 'dev');
  return { u, meta, logged, restarts: () => restarts };
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

test('npm ending without an error while the folder Ledung runs from keeps the old version fails the update on the page, with npm\'s output, and restarts nothing', async () => {
  const app = appFolder('elsewhere');
  const other = path.join(base, 'other-prefix', 'node_modules', 'ledung');
  const { u, logged, restarts } = updater(app, {
    // npm installs into another global folder than the one Ledung runs from.
    npmInstall: () => installInto(other, '1.2.0'),
    npmRoot: { cmd: process.execPath, args: ['-e', `console.log(${JSON.stringify(path.dirname(other))})`] },
  });
  u.runUpdate();
  const v = await settled(u);
  assert.equal(v.refused, `npm install -g ledung@1.2.0 ended without an error, but the Ledung in ${app} is still v1, so a restart would not run v1.2. npm installs global packages into ${path.dirname(other)}. The running Ledung was not changed.`);
  assert.deepEqual(v.steps.map((s) => s.state), ['done', 'failed', 'waiting']);
  assert.match(v.steps[1]!.output ?? '', /added 1 package in 2s/);
  assert.match(v.steps[1]!.output ?? '', /npm root -g: .*other-prefix/);
  assert.match(logged.join('\n'), /^Update: npm install -g ledung@1\.2\.0 ended without an error, but .* is still v1, .*\nadded 1 package in 2s/m);
  await afterRestartDelay();
  assert.equal(restarts(), 0);
  assert.equal(v.restarting, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version, '1.0.0');

  // The same probe where npm does reach the folder: the update goes on to its restart.
  const ok = appFolder('reached');
  const good = updater(ok, { npmInstall: () => installInto(ok, '1.2.0') });
  good.u.runUpdate();
  const done = await settled(good.u);
  assert.equal(done.refused, null);
  assert.deepEqual(done.steps.map((s) => s.state), ['done', 'done', 'running']);
  assert.match(good.logged.join('\n'), /installed 1\.2\.0 into .*reached/);
  await afterRestartDelay();
  assert.equal(good.restarts(), 1);
});

test('a Ledung that restarted after an update and still runs the old version says so; one on the new version says nothing', async () => {
  const app = appFolder('restart');
  const first = updater(app, { npmInstall: () => installInto(app, '1.2.0') });
  first.u.runUpdate();
  assert.equal((await settled(first.u)).refused, null);
  await afterRestartDelay();
  assert.equal(first.restarts(), 1);

  // The restart came back on 1.0.0: the old files, as on Martin's PC.
  const stale = updater(app, { meta: first.meta, npmVersion: '1.0.0' });
  assert.equal(stale.u.view().refused, `The update to v1.2 did not take: Ledung restarted and still runs v1, from ${app}. Update again, or run npm install -g ledung@1.2.0 and press Restart Ledung.`);
  assert.match(stale.logged.join('\n'), /did not take/);
  // Said once: the next start has nothing left to compare.
  assert.equal(updater(app, { meta: first.meta, npmVersion: '1.0.0' }).u.view().refused, null);

  // The same probe after an update that took: nothing to say.
  const second = updater(app, { npmInstall: () => installInto(app, '1.2.0') });
  second.u.runUpdate();
  assert.equal((await settled(second.u)).refused, null);
  await afterRestartDelay();
  const fresh = updater(app, { meta: second.meta, npmVersion: '1.2.0' });
  assert.equal(fresh.u.view().refused, null);
  assert.deepEqual(fresh.logged, []);
});

test("a failed npm install's error goes to the log as well as the page, as does a refusal before npm installs anything", async () => {
  const app = appFolder('locked');
  const { u, logged, restarts } = updater(app, {
    npmInstall: () => ({ cmd: process.execPath, args: ['-e', 'console.error("npm error code EBUSY\\nnpm error syscall rename"); process.exit(1)'] }),
  });
  u.runUpdate();
  const v = await settled(u);
  assert.match(v.refused ?? '', /npm install -g ledung@1\.2\.0 failed \(exit code \d+\)\. The running Ledung was not changed\./);
  assert.match(v.steps[1]!.output ?? '', /EBUSY/);
  assert.match(logged.join('\n'), /^Update: npm install -g ledung@1\.2\.0 failed \(exit code 1\)\. The running Ledung was not changed\.\nnpm error code EBUSY/m);
  await afterRestartDelay();
  assert.equal(restarts(), 0);

  // Refused at the first step: already on the newest version of the channel.
  const newest = updater(appFolder('newest'), { npmVersion: '1.2.0' });
  newest.u.runUpdate();
  assert.match((await settled(newest.u)).refused ?? '', /already the newest/);
  assert.match(newest.logged.join('\n'), /^Update: v1\.2 is already the newest on this channel\. The running Ledung was not changed\.$/m);
});

test('the running version is the one read first, whatever the disk says later', () => {
  assert.equal(runningVersion(() => '3.11.0'), '3.11.0');
  // npm has since put 3.13.0 on disk: About and the page's build still name what runs.
  assert.equal(runningVersion(() => '3.13.0'), '3.11.0');
});
