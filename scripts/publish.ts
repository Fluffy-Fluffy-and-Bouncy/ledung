// Publishes the npm package to a channel (issue #461; Martin, 2026-11-02 00:38, Ledung question #1172):
//
//   npm run publish:dev [-- --dry-run]                         the next dev build, X.Y, to npm's `dev` tag
//   npm run publish:public -- --confirm <version> [--dry-run]  the next public release, X, to `latest`
//
// A dev build is published by the manager after merges; a public release only on the owners' word (Martin or FFBuddha), which is why it
// asks for the version typed back. `npm install -g ledung` gets `latest`, so a dev build never reaches it: the dev
// command only ever names the `dev` tag, and neither command moves a tag by itself (no `npm dist-tag`).
//
// The version is counted from what npm has published and the clone's own (a dev build after v1 or v1.1 is v1.2, a
// public release after either is v2) and stamped into the package only: nothing is committed, so publishing needs
// no push to main. Both refuse anything but a clean main that is origin/main, so what is published is what merged.
// --dry-run (also `npm run publish:dev --dry-run`, which npm passes on as npm_config_dry_run) checks, builds and
// packs, and prints the publish it would run instead of running it.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDir } from '../src/platform/paths.ts';
import { CHANNEL_TAG, CHANNELS, displayVersion, isDevVersion, isPublicVersion, nextVersion, type Channel } from '../src/shared/version.ts';
import { buildPackage, npm } from './build-package.ts';

const BRANCH = 'main';

export interface PublishOptions {
  channel: Channel;
  dryRun: boolean;
  /** The version typed back for a public release. */
  confirm?: string;
}

/** The command line, and npm's own --dry-run when given to `npm run` without `--`. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): PublishOptions {
  const channel = argv[0] as Channel;
  if (!CHANNELS.includes(channel)) throw new Error(`The channel is ${CHANNELS.join(' or ')}, not ${argv[0] ?? 'missing'}.`);
  const at = argv.indexOf('--confirm');
  const confirm = at >= 0 ? argv[at + 1] : undefined;
  return { channel, dryRun: argv.includes('--dry-run') || env.npm_config_dry_run === 'true', confirm };
}

/** What the refusals are decided on. */
export interface PublishState {
  branch: string;
  /** Tracked files with changes, or untracked files where the package is built from (PACKAGED_PATHS). */
  dirty: boolean;
  head: string;
  originHead: string;
  /** The version this build would get. */
  version: string;
  /** Every version npm has. */
  published: string[];
}

/** Why the clone must not be published from, whatever the version: another branch, changes, not what merged. */
export function cloneRefusals(s: Pick<PublishState, 'branch' | 'dirty' | 'head' | 'originHead'>): string[] {
  const out: string[] = [];
  if (s.branch !== BRANCH) out.push(`The clone is on ${s.branch === 'HEAD' ? 'no branch' : `branch ${s.branch}`}, not ${BRANCH}.`);
  if (s.dirty) out.push('The clone has uncommitted changes.');
  if (s.head !== s.originHead) out.push(`${BRANCH} is not origin/${BRANCH} (${s.head.slice(0, 7)} against ${s.originHead.slice(0, 7)}): publish only what has merged.`);
  return out;
}

/** Why this build must not be published; empty when it may. */
export function refusals(opts: PublishOptions, s: PublishState): string[] {
  const out = cloneRefusals(s);
  if (opts.channel === 'dev' && !isDevVersion(s.version)) out.push(`${s.version} is not a dev build's X.Y (a plain number is a public release).`);
  if (opts.channel === 'public' && !isPublicVersion(s.version)) out.push(`${s.version} is not a plain number: a public release is X.`);
  if (s.published.includes(s.version)) out.push(`${s.version} is already on npm.`);
  if (opts.channel === 'public' && !opts.dryRun && opts.confirm !== s.version) {
    out.push(`A public release is the owners' word (Martin or FFBuddha): run it again with --confirm ${s.version} to publish ${displayVersion(s.version)} to everyone.`);
  }
  return out;
}

/** npm's arguments for the publish: always the channel's own tag, so a dev build never becomes `latest`. */
export function publishArgs(channel: Channel, tgz: string): string[] {
  return ['publish', tgz, '--tag', CHANNEL_TAG[channel], '--access', 'public'];
}

/** npm view's versions: a list, a single version as a string, or nothing for a package never published. */
export function publishedVersions(json: string): string[] {
  const v = json.trim() ? JSON.parse(json) : [];
  return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function npmView(name: string, cwd: string): string[] {
  const args = ['view', name, 'versions', '--json'];
  const r = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: 'utf8' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status === 0) return publishedVersions(r.stdout);
  if (/E404/.test(`${r.stdout}${r.stderr}`)) return [];
  throw new Error(`npm view ${name} failed:\n${r.stderr || r.stdout}`);
}

/**
 * What goes into the package besides tracked files: an untracked file here is built or copied in (web/public into the
 * page, for one), so it counts as an uncommitted change (code review of PR #13, minor 2). Untracked files elsewhere,
 * such as backups beside the config, are left out of the package and don't stop a publish.
 */
export const PACKAGED_PATHS = ['src', 'web', 'scripts', 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'COMMERCIAL.md', 'ledung.config.example.json'];

/** The clone's side of the state, read with git after fetching origin/main. */
export function cloneState(source: string): Pick<PublishState, 'branch' | 'dirty' | 'head' | 'originHead'> {
  git(source, ['fetch', '--quiet', 'origin', BRANCH]);
  const changed = git(source, ['status', '--porcelain', '--untracked-files=no']);
  const untracked = git(source, ['status', '--porcelain', '--untracked-files=all', '--', ...PACKAGED_PATHS]);
  return {
    branch: git(source, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: changed !== '' || untracked !== '',
    head: git(source, ['rev-parse', 'HEAD']),
    originHead: git(source, ['rev-parse', `origin/${BRANCH}`]),
  };
}

/** Everything the publish does outside git; tests replace them, so nothing reaches npm. */
export interface PublishSteps {
  npmView(name: string, cwd: string): string[];
  check(source: string): void;
  build(source: string, version: string): Promise<string>;
  publish(args: string[], source: string): void;
  log(line: string): void;
  error(line: string): void;
}

const REAL_STEPS: PublishSteps = {
  npmView,
  check: (source) => npm(['run', 'check', '--silent'], source),
  build: buildPackage,
  publish: (args, source) => npm(args, source),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/** Publishes `source` to the channel; 0 when published (or a dry run went through), 1 when refused. */
export async function runPublish(opts: PublishOptions, source: string, steps: PublishSteps = REAL_STEPS): Promise<number> {
  const clone = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')) as { name: string; version: string };
  const local = cloneState(source);
  const refuse = (reasons: string[]) => {
    for (const r of reasons) steps.error(`Refused: ${r}`);
    return 1;
  };
  // The clone is refused before npm is asked or anything is built (test review of PR #13, finding 2).
  const early = cloneRefusals(local);
  if (early.length) return refuse(early);
  const published = steps.npmView(clone.name, source);
  const version = nextVersion(opts.channel, [...published, clone.version]);
  const tag = CHANNEL_TAG[opts.channel];
  steps.log(`${clone.name} ${version} (${displayVersion(version)}) from ${local.head.slice(0, 7)}, to npm's ${tag} tag${opts.dryRun ? ' (dry run)' : ''}.`);
  const refused = refusals(opts, { ...local, version, published });
  if (refused.length) return refuse(refused);
  if (!opts.dryRun) {
    steps.log('Checking...');
    steps.check(source);
  }
  const tgz = await steps.build(source, version);
  const args = publishArgs(opts.channel, tgz);
  if (opts.dryRun) {
    steps.log(`Dry run: would run npm ${args.join(' ')}`);
    return 0;
  }
  steps.publish(args, source);
  steps.log(`Published ${displayVersion(version)} to ${tag}.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await runPublish(parseArgs(process.argv.slice(2)), appDir());
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
