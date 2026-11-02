// The tests' hang limits come from test/limits.ts, never a number in place (issue #463): a 20 s limit on a test that
// takes 0.6 s alone failed Martin's release under a full run's load. Not test/loopback: those are run by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = import.meta.dirname;
const files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.ts') && !f.split(path.sep).includes('loopback') && f !== 'limits.ts' && f !== 'limits.test.ts');

const RULES: [RegExp, string][] = [
  [/\btimeout:\s*\d/, "a test's or a child process's timeout: HANG_MS"],
  // Any name, and a product of numbers: `2 * WAIT_MS` passes, `5 * 1000` doesn't (test review of PR #77, Important 2).
  [/\b\w+\s*=\s*Date\.now\(\)\s*\+\s*\d[\d_]*(?:\s*\*\s*\d[\d_]*)*\s*[;)]/, 'a deadline for a wait: WAIT_MS'],
  [/\b(?:until|waitFor|within)\s*(?:<[^>]*>)?\([^{]*\bms\s*=\s*\d/, "a wait helper's budget: WAIT_MS"],
  // The same budget given where the helper is called, as host.test's `within(…, 20000, …)` was.
  [/\b(?:until|waitFor|within)\s*\(.*,\s*\d[\d_]{3,}\s*[,)]/, "a wait helper's budget: WAIT_MS"],
  // A deadline raced against an event: a timer that settles the wait or kills the child (test review of PR #77, round
  // 2, Important 1). A plain sleep, `setTimeout(r, 300)`, isn't one.
  [/\bsetTimeout\(\s*\(\)\s*=>\s*(?:resolve|reject|r|[\w.]+\.kill)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*,\s*\d[\d_]{3,}\s*\)/,'a deadline on an event: WAIT_MS, or HANG_MS for a child process'],
];

test('every test timeout and wait budget is a limit from test/limits.ts, not a number', () => {
  assert.ok(files.length > 50, `the tests were found (${files.length})`);
  const found: string[] = [];
  for (const f of files) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      for (const [rule, use] of RULES) if (rule.test(line)) found.push(`test/${f.replaceAll('\\', '/')}:${i + 1}: ${use}`);
    });
  }
  assert.deepEqual(found, []);
});

test('the rules catch the forms they are for', () => {
  const caught = (line: string) => RULES.some(([rule]) => rule.test(line));
  for (const line of [
    "test('x', { timeout: 20_000 }, async () => {",
    'const T = { timeout: 10_000 };',
    "spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000 });",
    '  const end = Date.now() + 5000;',
    '  const until = Date.now() + 3000;',
    '  for (const end = Date.now() + 30_000; Date.now() < end;) {',
    'async function until(what: () => boolean, ms = 3000): Promise<void> {',
    "async function waitFor(what: string, ok: () => boolean, ms = 4000): Promise<void> {",
    '    async waitFor(pred, ms = 20000) {',
    "  await within(ended, 20000, 'the connection ending');",
    "  await until(() => t.status().state === 'connected', 5000);",
    "  await waitFor('x', ok, 4000);",
    '  const stop = Date.now() + 5000;',
    '  const end = Date.now() + 5 * 1000;',
    "    setTimeout(() => resolve('still open'), 3000).unref();",
    "  assert.equal(await Promise.race([page.closed, new Promise((r) => setTimeout(() => r('still open'), 3000))]), 1008);",
    '      const timer = setTimeout(() => reject(new Error(`not running within 30 s:\\n${out}`)), 30_000);',
    '    const timer = setTimeout(() => child.kill(), 60_000);',
  ]) assert.ok(caught(line), line);
  for (const line of [
    "test('x', { timeout: HANG_MS }, async () => {",
    '  const end = Date.now() + 2 * WAIT_MS;',
    "startShell(cmd, { timeoutMs: 6000 });",
    'const later = () => clock(Date.now() + 2 * 3600_000);',
    "function raw(port: number, bytes: string, ms = 1500): Promise<string> {",
    "  await within(ended, WAIT_MS, 'the connection ending');",
    "  await until(() => calls.length === 2, 'two calls');",
    '  await new Promise((r) => setTimeout(r, 1500));',
    "    new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 200)),",
    '    const timer = setTimeout(() => child.kill(), HANG_MS);',
    "  assert.equal(await Promise.race([page.closed, new Promise((r) => setTimeout(() => r('still open'), WAIT_MS))]), 1008);",
  ]) assert.ok(!caught(line), line);
});
