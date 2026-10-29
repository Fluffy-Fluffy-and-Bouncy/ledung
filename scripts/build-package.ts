// Builds the npm package (#105):
//
//   npm run pack        builds dist/package/ and packs it into dist/ledung-<version>.tgz
//
// Node does not strip TypeScript types from files under node_modules, so the package carries plain
// JavaScript: the core, the session host and the `ledung` command, each bundled into one file in
// dist/, and the page in web/dist. The runtime dependencies stay outside the bundles and are
// installed by npm as usual. Developing (node src/main.ts) and npm run release don't use any of it.
//
// The package is put together in its own folder with a package.json of its own, without this
// clone's scripts and devDependencies: npm warns about a published package's `prepare` script on
// every install, and ours only switches on the clone's git hooks.
//
// The package installs exactly the dependencies `npm run check` ran against (#421): its package.json
// names the lockfile's versions instead of the clone's caret ranges, and an npm-shrinkwrap.json made
// from the lockfile's production entries pins everything below them. Without it, a fresh install
// got a newer Agent SDK than the tests, and with it a newer minimum Claude Code (#341).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { appDir } from '../src/platform/paths.ts';

/** dist/<name>.js for each entry; src/platform/paths.ts, src/cli.ts and src/platform/node-warnings.ts find the host, main and preload by these names; preload sits next to main. */
export const ENTRIES = { main: 'src/main.ts', host: 'src/host/host.ts', cli: 'src/cli.ts', preload: 'src/preload.ts' } as const;

/** Besides dist/ and web/dist/, from the clone into the package. */
const EXTRA_FILES = ['README.md', 'CHANGELOG.md', 'ledung.config.example.json', 'LICENSE', 'COMMERCIAL.md'];

/** The fields of the clone's package.json the package keeps; everything else is for development. */
const MANIFEST_FIELDS = ['name', 'version', 'private', 'license', 'description', 'type', 'bin', 'files', 'repository', 'homepage', 'bugs', 'engines', 'dependencies'];

export function packageManifest(clone: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(MANIFEST_FIELDS.filter((k) => clone[k] !== undefined).map((k) => [k, clone[k]]));
}

type Lock = { lockfileVersion?: number; packages?: Record<string, Record<string, unknown>> };

/** The lockfile's version of each of the clone's dependencies; refuses a lockfile out of step with package.json. */
export function pinnedDependencies(clone: Record<string, unknown>, lock: Lock): Record<string, string> {
  const ranges = (clone.dependencies ?? {}) as Record<string, string>;
  const locked = (lock.packages?.['']?.dependencies ?? {}) as Record<string, string>;
  if (JSON.stringify(Object.entries(ranges).sort()) !== JSON.stringify(Object.entries(locked).sort())) {
    throw new Error('package-lock.json does not match package.json\'s dependencies: run npm install first');
  }
  return Object.fromEntries(Object.keys(ranges).map((name) => {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (typeof version !== 'string') throw new Error(`package-lock.json has no version of ${name}`);
    return [name, version];
  }));
}

/** An entry for some systems only (os, cpu or libc), such as the Agent SDK's eight per-platform packages. */
export function platformOnly(entry: Record<string, unknown>): boolean {
  return entry.os !== undefined || entry.cpu !== undefined || entry.libc !== undefined;
}

/** The Agent SDK's per-platform packages, each a copy of Claude Code for one system. */
const SDK_PLATFORM = /^node_modules\/@anthropic-ai\/claude-agent-sdk-[^/]+$/;

/**
 * Whether the shrinkwrap leaves a production entry out. npm installs every entry a dependency's shrinkwrap
 * lists, whatever the platform: with the SDK's eight in, a global install took 2.0 GB instead of 303 MB
 * (#421). Left out, none of them is installed, since npm installs only what the shrinkwrap lists: an npm
 * install has no Claude Code of its own, so "bundled" has nothing to run (the lead's decision on question
 * #447), and Ledung always gives the SDK a program path (Session.programPath). Any other platform-only
 * entry stops the build, so it is decided rather than silently missing (review of PR #441).
 */
export function leftOut(key: string, entry: Record<string, unknown>): boolean {
  if (!platformOnly(entry)) return false;
  if (SDK_PLATFORM.test(key)) return true;
  throw new Error(`${key} is a production dependency for some platforms only: decide how the npm package handles it (see #421)`);
}

/**
 * npm-shrinkwrap.json for the package: the lockfile without its development entries (dev and
 * dev-only optional ones such as fsevents) and without the Agent SDK's per-platform ones, under the
 * package's own manifest. npm honours a
 * shrinkwrap inside an installed package, unlike a package-lock.json.
 */
export function packageShrinkwrap(manifest: Record<string, unknown>, lock: Lock): Record<string, unknown> {
  if (lock.lockfileVersion !== 3 || !lock.packages) throw new Error('package-lock.json is not lockfileVersion 3');
  const root = Object.fromEntries(['name', 'version', 'license', 'dependencies', 'bin', 'engines'].filter((k) => manifest[k] !== undefined).map((k) => [k, manifest[k]]));
  const packages: Record<string, unknown> = { '': root };
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key !== '' && !entry.dev && !leftOut(key, entry)) packages[key] = entry;
  }
  return { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages };
}

/** Bundles the core, the host and the command into outDir. */
export async function bundleCore(source: string, outDir: string): Promise<void> {
  await build({
    entryPoints: Object.fromEntries(Object.entries(ENTRIES).map(([name, file]) => [name, path.join(source, file)])),
    outdir: outDir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // zod, ws and the Agent SDK come from the package's own node_modules (the SDK finds its files there).
    packages: 'external',
    logLevel: 'warning',
  });
}

/** Puts the whole package together in stage; the page must have been built into web/dist. */
export async function stagePackage(source: string, stage: string): Promise<void> {
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const clone = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(source, 'package-lock.json'), 'utf8')) as Lock;
  const trimmed = packageManifest(clone);
  // npm pack leaves the shrinkwrap out when files is set and doesn't name it (npm 11).
  const files = trimmed.files ? { files: [...(trimmed.files as string[]), 'npm-shrinkwrap.json'] } : {};
  const manifest = { ...trimmed, ...files, dependencies: pinnedDependencies(clone, lock) };
  fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(stage, 'npm-shrinkwrap.json'), `${JSON.stringify(packageShrinkwrap(manifest, lock), null, 2)}\n`);
  await bundleCore(source, path.join(stage, 'dist'));
  fs.cpSync(path.join(source, 'web', 'dist'), path.join(stage, 'web', 'dist'), { recursive: true });
  for (const file of EXTRA_FILES) fs.cpSync(path.join(source, file), path.join(stage, file));
}

// npm through node and npm's own script when run by npm, so no shell is involved (as in release.ts).
function npm(args: string[], cwd: string): void {
  const stdio: ['ignore', 'inherit', 'inherit'] = ['ignore', 'inherit', 'inherit'];
  if (process.env.npm_execpath) execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, stdio });
  else execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, stdio, shell: process.platform === 'win32' });
}

async function main(): Promise<void> {
  const source = appDir();
  const out = path.join(source, 'dist');
  const stage = path.join(out, 'package');
  console.log('Building the page...');
  npm(['run', 'build', '--silent'], source);
  console.log('Bundling the core, the session host and the ledung command...');
  await stagePackage(source, stage);
  console.log('Packing...');
  npm(['pack', '--pack-destination', out], stage);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
