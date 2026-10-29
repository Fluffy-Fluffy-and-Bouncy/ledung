// No test reaches a real sign-in store (issue #347): the I1 test used the default stores, which on macOS are the
// user's login Keychain, and wrote its token into a real entry nobody removed. This reads the tests' own source
// and fails on every way back to a default store it knows of; the rules are tried on probes first, so a rule that
// stopped finding anything can't pass unseen (review of PR #348, test finding 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { removeTemp } from './temp.ts';

const dir = import.meta.dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== path.basename(import.meta.filename));

/** The top-level arguments of every call of `name(` in the text, as written. */
function calls(text: string, name: string): string[][] {
  const found: string[][] = [];
  for (const m of text.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
    const args: string[] = [];
    let depth = 0;
    let start = m.index + m[0].length;
    for (let i = start; i < text.length; i++) {
      const c = text[i]!;
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c) && depth > 0) depth--;
      else if ((c === ',' && depth === 0) || c === ')') {
        args.push(text.slice(start, i).trim());
        start = i + 1;
        if (c === ')') break;
      }
    }
    found.push(args.filter((a) => a !== ''));
  }
  return found;
}

/**
 * Rule 1: the stores and sign-outs made with the computer's own platform, or on macOS without a runner of the
 * test's own: `localStore(platform, run)` and `removeSignIn(place, platform, run)`. The real runner is refused by
 * name (review of PR #348, M1).
 */
function unpinnedStores(text: string): string[] {
  const bad: string[] = [];
  for (const [name, at] of [['localStore', 0], ['removeSignIn', 1]] as const) {
    for (const args of calls(text, name)) {
      const platform = args[at];
      const literal = !!platform && /^'[a-z0-9]+'$/.test(platform);
      const ownRun = args.length >= at + 2 && args[at + 1] !== 'runWithInput';
      if (!literal || (platform === "'darwin'" && !ownRun) || args.includes('runWithInput')) bad.push(`${name}(${args.join(', ')})`);
    }
  }
  return bad;
}

/**
 * Rule 2: how many session managers the text makes without the refusing helper. Every one, whatever the test calls
 * on it: a check, a start, a removal or the server's Check again all reach the defaults (review of PR #348, I1).
 */
function unguardedManagers(text: string): number {
  return (text.match(/new SessionManager\(/g)?.length ?? 0) - (text.match(/refuseRealSignInStores\(new SessionManager\(/g)?.length ?? 0);
}

test('the rules find what they are for: the bad calls and managers are found, the good ones are not', () => {
  const probe = [
    "localStore();", "localStore('darwin');", "localStore('darwin', runWithInput);", 'localStore(process.platform, run);',
    'removeSignIn(place);', "removeSignIn({ kind: 'local', folder: f }, 'darwin');", "removeSignIn(p, 'darwin', runWithInput);",
    "localStore('win32');", "localStore('darwin', async (_c, args) => ({ stdout: args.join(',') }));", "removeSignIn(p, 'darwin', run);", "removeSignIn({ kind: 'local', folder: path.join(a, 'b') }, 'win32');",
  ].join('\n');
  assert.deepEqual(unpinnedStores(probe), [
    'localStore()', "localStore('darwin')", "localStore('darwin', runWithInput)", 'localStore(process.platform, run)',
    'removeSignIn(place)', "removeSignIn({ kind: 'local', folder: f }, 'darwin')", "removeSignIn(p, 'darwin', runWithInput)",
  ]);
  const managers = [
    'const a = refuseRealSignInStores(new SessionManager(parseConfig({ port }), store, () => {}));',
    'const b = new SessionManager(parseConfig({}), store, () => {});',
    "await b.removeAccount('x');",
  ].join('\n');
  assert.equal(unguardedManagers(managers), 1);
  assert.equal(unguardedManagers(managers.split('\n')[0]!), 0);
});

test('every store a test makes names its platform, and a macOS one its own run: never the real Keychain (#347)', () => {
  assert.deepEqual(files.flatMap((f) => unpinnedStores(fs.readFileSync(path.join(dir, f), 'utf8')).map((c) => `${f}: ${c}`)), []);
});

test('every session manager a test makes refuses the real sign-in stores, sign-out and checks (#347)', () => {
  assert.ok(files.some((f) => /new SessionManager\(/.test(fs.readFileSync(path.join(dir, f), 'utf8'))), 'the tests make session managers');
  assert.deepEqual(files.filter((f) => unguardedManagers(fs.readFileSync(path.join(dir, f), 'utf8')) !== 0), []);
});

test('a test that reaches a refused store or check fails its file, though the manager turns the error into an answer (review of PR #348, round 2)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-refused-'));
  try {
    const helper = pathToFileURL(path.join(dir, 'signin-stores.ts')).href;
    // A test file as the suite runs one, under node --test, on its own (not as a child of this run).
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = (reach: boolean) => {
      const file = path.join(base, `${reach ? 'reach' : 'quiet'}.test.ts`);
      fs.writeFileSync(file, [
        "import { test } from 'node:test';",
        `import { refuseRealSignInStores } from '${helper}';`,
        'const manager = refuseRealSignInStores({} as never) as unknown as { checkSignInWith: () => Promise<unknown> };',
        // Caught, as the manager's own check does: only the helper's count can tell.
        `test('a check', async () => { if (${reach}) await manager.checkSignInWith().catch(() => null); });`,
      ].join('\n'));
      const r = spawnSync(process.execPath, ['--test', file], { env, encoding: 'utf8', timeout: 60_000 });
      return { status: r.status, out: `${r.stdout}${r.stderr}` };
    };
    const reached = run(true);
    assert.notEqual(reached.status, 0, reached.out);
    assert.match(reached.out, /a test reached a real sign-in store or check \(#347\)/);
    const quiet = run(false);
    assert.equal(quiet.status, 0, quiet.out);
    assert.doesNotMatch(quiet.out, /a test reached a real sign-in store or check/);
  } finally {
    removeTemp(base);
  }
});
