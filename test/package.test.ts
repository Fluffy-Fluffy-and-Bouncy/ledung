// The npm package (#105): what it ships, that the bundles run as plain JavaScript, where an
// npm-installed Ledung keeps its config and that its first start writes one, and that its Update
// panel says updates come from npm instead of pulling a git source.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { bundleCore, ENTRIES, packageManifest, packageShrinkwrap, pinnedDependencies, platformOnly, stagePackage } from '../scripts/build-package.ts';
import { configPath, createDefaultConfig, loadConfig } from '../src/config.ts';
import { appDir, hostEntry, PACKAGED } from '../src/platform/paths.ts';
import { NPM_REASON, Updater } from '../src/update/updater.ts';
import { removeTemp } from './temp.ts';
import { freePort } from './free-port.ts';

let base: string;
const savedEnv = { config: process.env.LEDUNG_CONFIG, data: process.env.LEDUNG_DATA_DIR };

before(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-package-'));
});

after(() => {
  removeTemp(base);
  for (const [k, v] of [['LEDUNG_CONFIG', savedEnv.config], ['LEDUNG_DATA_DIR', savedEnv.data]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const clonePackage = () => JSON.parse(fs.readFileSync(path.join(appDir(), 'package.json'), 'utf8'));

test('package.json has what a publish needs, and the command is the bundled cli', () => {
  const pkg = clonePackage();
  assert.deepEqual(pkg.bin, { ledung: 'dist/cli.js' });
  assert.ok('cli' in ENTRIES);
  for (const field of ['files', 'engines', 'version', 'repository']) assert.ok(pkg[field], `${field} is set`);
  assert.match(pkg.engines.node, /24/);
  // Publishing decisions stay Martin's (#105): private is left on.
  assert.equal(pkg.private, true);
});

test("the package's own package.json has no scripts or devDependencies (npm warns about a prepare script on install)", () => {
  const manifest = packageManifest(clonePackage());
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.devDependencies, undefined);
  // acme-client: Ledung's own certificate by ACME (issue #202, "a new dependency, bundled by pack").
  assert.deepEqual(Object.keys(manifest.dependencies as object).sort(), ['@anthropic-ai/claude-agent-sdk', '@simplewebauthn/server', 'acme-client', 'ws', 'zod']);
  assert.equal(manifest.bin && (manifest.bin as Record<string, string>).ledung, 'dist/cli.js');
});

// #421: a fresh `npm install -g` of the tgz got Agent SDK 0.3.312 while the lockfile, and so every
// test, had 0.3.295, and the newer SDK asked for a newer Claude Code than the tests did.
test('the staged package pins every dependency to the lockfile, through its package.json and an npm-shrinkwrap.json that npm pack ships', async () => {
  // A source folder like the clone, with a stand-in page, so staging doesn't need a page build.
  const source = path.join(base, 'source');
  fs.mkdirSync(path.join(source, 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(source, 'web', 'dist', 'index.html'), '<!doctype html>');
  for (const file of ['package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'ledung.config.example.json', 'LICENSE', 'COMMERCIAL.md']) {
    fs.cpSync(path.join(appDir(), file), path.join(source, file));
  }
  fs.symlinkSync(path.join(appDir(), 'src'), path.join(source, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
  const stage = path.join(base, 'stage');
  await stagePackage(source, stage);

  const lock = JSON.parse(fs.readFileSync(path.join(appDir(), 'package-lock.json'), 'utf8'));
  const lockedVersion = (name: string) => lock.packages[`node_modules/${name}`].version as string;
  const SDK = '@anthropic-ai/claude-agent-sdk';

  const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  for (const name of Object.keys(clonePackage().dependencies)) {
    assert.equal(manifest.dependencies[name], lockedVersion(name), `${name} is the lockfile's exact version`);
  }

  const shrinkwrap = JSON.parse(fs.readFileSync(path.join(stage, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(shrinkwrap.lockfileVersion, 3);
  assert.deepEqual(shrinkwrap.packages[''].dependencies, manifest.dependencies);
  assert.equal(shrinkwrap.packages[`node_modules/${SDK}`].version, lockedVersion(SDK));
  // Everything a production install takes from the lockfile, at the lockfile's version, and nothing for development.
  // The Agent SDK's per-platform copies of Claude Code stay out: npm installs every one a shrinkwrap lists,
  // 2.0 GB instead of 303 MB (#421). Only those: any other production entry is in.
  const sdkPlatform = (k: string) => k.startsWith(`node_modules/${SDK}-`) && !k.slice(`node_modules/${SDK}-`.length).includes('/');
  const production = Object.keys(lock.packages).filter((k) => k !== '' && !lock.packages[k].dev && !sdkPlatform(k)).sort();
  assert.ok(Object.keys(lock.packages).some((k) => sdkPlatform(k) && platformOnly(lock.packages[k])), 'the lockfile has the SDK\'s platform entries');
  assert.deepEqual(Object.keys(shrinkwrap.packages).filter((k) => k !== '').sort(), production);
  for (const key of production) assert.equal(shrinkwrap.packages[key].version, lock.packages[key].version, key);
  assert.equal(shrinkwrap.packages['node_modules/typescript'], undefined);

  // npm pack puts the shrinkwrap into the tgz (offline: --dry-run only lists).
  const npmCli = process.env.npm_execpath;
  const packed = npmCli
    ? spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], { cwd: stage, encoding: 'utf8' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], { cwd: stage, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(packed.status, 0, packed.stderr);
  const files = (JSON.parse(packed.stdout)[0].files as { path: string }[]).map((f) => f.path);
  assert.ok(files.includes('npm-shrinkwrap.json'), files.join(', '));
});

test('a production dependency for some platforms only, other than the Agent SDK\'s copies, stops the build instead of going missing (review of PR #441)', () => {
  const manifest = { name: 'ledung', version: '0.1.0', dependencies: { 'native-thing': '1.0.0' } };
  const lock = (extra: Record<string, Record<string, unknown>>) => ({ lockfileVersion: 3, packages: { '': { dependencies: { 'native-thing': '^1.0.0' } }, ...extra } });
  const sdkCopy = { version: '0.3.295', optional: true, os: ['darwin'], cpu: ['arm64'] };
  const sw = packageShrinkwrap(manifest, lock({ 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64': sdkCopy, 'node_modules/esbuild-darwin': { version: '1.0.0', dev: true, os: ['darwin'] } }));
  assert.deepEqual(Object.keys(sw.packages as object), [''], "the SDK's copy and a development entry are left out");
  assert.throws(() => packageShrinkwrap(manifest, lock({ 'node_modules/native-thing-linux-x64': { version: '1.0.0', optional: true, os: ['linux'], cpu: ['x64'] } })), /native-thing-linux-x64 is a production dependency for some platforms only/);
  assert.throws(() => packageShrinkwrap(manifest, lock({ 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/node_modules/x': { version: '1.0.0', os: ['darwin'] } })), /for some platforms only/);
});

test('staging refuses a lockfile out of step with package.json, instead of pinning the wrong versions', () => {
  const clone = { dependencies: { zod: '^4.6.5' } };
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: { zod: '^4.6.5' } }, 'node_modules/zod': { version: '4.6.7' } } };
  assert.deepEqual(pinnedDependencies(clone, lock), { zod: '4.6.7' });
  assert.throws(() => pinnedDependencies({ dependencies: { zod: '^5.0.0' } }, lock), /does not match/);
  assert.throws(() => pinnedDependencies(clone, { lockfileVersion: 3, packages: { '': { dependencies: { zod: '^4.6.5' } } } }), /no version of zod/);
});

test('from the source, Ledung is not packaged and hosts run the TypeScript host', () => {
  assert.equal(PACKAGED, false);
  assert.ok(fs.existsSync(path.join(appDir(), 'package.json')));
  assert.equal(hostEntry(), path.join(appDir(), 'src', 'host', 'host.ts'));
  assert.equal(hostEntry(true), path.join(appDir(), 'dist', 'host.js'));
});

test('the bundles run as plain JavaScript from a folder like the installed package', async () => {
  const pkgDir = path.join(base, 'pkg');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'ledung', version: '9.8.7', type: 'module' }));
  // The dependencies the bundles leave outside, where npm would install them.
  fs.symlinkSync(path.join(appDir(), 'node_modules'), path.join(pkgDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await bundleCore(appDir(), path.join(pkgDir, 'dist'));
  for (const name of Object.keys(ENTRIES)) assert.ok(fs.existsSync(path.join(pkgDir, 'dist', `${name}.js`)), `dist/${name}.js`);
  // The command finds the package.json above dist/: the version comes from the package, not the clone.
  const r = spawnSync(process.execPath, [path.join(pkgDir, 'dist', 'cli.js'), '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '9.8.7');
  // The host loads and reads its spec (a missing one is its own error, not a module or type error).
  const h = spawnSync(process.execPath, [path.join(pkgDir, 'dist', 'host.js'), path.join(base, 'no-such-spec.json')], { encoding: 'utf8', timeout: 20_000 });
  assert.doesNotMatch(h.stderr, /ERR_UNKNOWN_FILE_EXTENSION|ERR_MODULE_NOT_FOUND|SyntaxError/);
  assert.match(h.stderr, /ENOENT.*no-such-spec\.json/);

  // The core starts as the package (review of PR #106): with LEDUNG_CONFIG unset it reads its config
  // from the data folder, which only the bundle's PACKAGED flag decides. A free port, never the real 4317.
  const data = path.join(base, 'bundle-data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'ledung.config.json'), JSON.stringify({ port: await freePort() }));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('LEDUNG_')) env[k] = v;
  env.LEDUNG_DATA_DIR = data;
  const core = spawn(process.execPath, [path.join(pkgDir, 'dist', 'main.js'), '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise<void>((resolve) => core.on('exit', () => resolve()));
  let out = '';
  try {
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no Config line within 30 s:\n${out}`)), 30_000);
      const look = (d: Buffer) => {
        out += d;
        const m = /^Config: (.*)$/m.exec(out);
        if (m) { clearTimeout(timer); resolve(m[1]!.trim()); }
      };
      core.stdout.on('data', look);
      core.stderr.on('data', look);
      core.on('exit', (code) => { clearTimeout(timer); reject(new Error(`main.js exited (${code}) before its Config line:\n${out}`)); });
    });
    assert.equal(line, path.join(data, 'ledung.config.json'));
  } finally {
    // Stopped by its own pid; it started no sessions, so no hosts are left behind.
    if (core.exitCode === null) core.kill();
    await exited;
  }
});

test('an npm-installed Ledung keeps its config in the data folder and writes a default one on its first start', () => {
  const data = path.join(base, 'data');
  delete process.env.LEDUNG_CONFIG;
  process.env.LEDUNG_DATA_DIR = data;
  const file = configPath(true);
  assert.equal(file, path.join(data, 'ledung.config.json'));
  // From a clone or a release it stays next to package.json, as before.
  assert.equal(configPath(false), path.join(appDir(), 'ledung.config.local.json'));

  assert.equal(createDefaultConfig(file), true);
  assert.equal(loadConfig(file).port, 4317);
  // Never overwrites a config that is there.
  fs.writeFileSync(file, JSON.stringify({ port: 4398 }));
  assert.equal(createDefaultConfig(file), false);
  assert.equal(loadConfig(file).port, 4398);
});

test("an npm-installed Ledung's Update panel shows the version and points to npm, and never pulls", async () => {
  // A release.json as a git release has: without the npm version this Ledung would offer a git update.
  const app = path.join(base, 'app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'release.json'), JSON.stringify({ source: path.join(base, 'no-clone'), commit: 'abc' }));
  let restarts = 0;
  const u = new Updater({ appDir: app, dataDir: base, configPath: path.join(base, 'c.json'), onRestart: () => { restarts++; }, npmVersion: '0.1.0' });

  const v = u.view();
  assert.equal(v.available, false);
  assert.deepEqual(v.npm, { version: '0.1.0' });
  assert.equal(v.reason, NPM_REASON);

  const checked = await u.runCheck();
  assert.equal(checked.check, null);
  assert.equal(checked.checkError, null);
  const started = u.startUpdate();
  assert.equal(started.updating, false);
  assert.equal(started.refused, NPM_REASON);
  assert.equal(restarts, 0);

  // The same folder without the npm version is a git release, as before.
  assert.equal(new Updater({ appDir: app, dataDir: base, configPath: path.join(base, 'c.json') }).view().available, true);
});
