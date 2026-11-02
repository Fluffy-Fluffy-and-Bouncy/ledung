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
  [/\b(?:end|until|deadline)\s*=\s*Date\.now\(\)\s*\+\s*\d[\d_]*\s*[;)]/, 'a deadline for a wait: WAIT_MS'],
  [/\b(?:until|waitFor|within)\s*(?:<[^>]*>)?\([^{]*\bms\s*=\s*\d/, "a wait helper's budget: WAIT_MS"],
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
  ]) assert.ok(caught(line), line);
  for (const line of [
    "test('x', { timeout: HANG_MS }, async () => {",
    '  const end = Date.now() + 2 * WAIT_MS;',
    "startShell(cmd, { timeoutMs: 6000 });",
    'const later = () => clock(Date.now() + 2 * 3600_000);',
    "function raw(port: number, bytes: string, ms = 1500): Promise<string> {",
  ]) assert.ok(!caught(line), line);
});
