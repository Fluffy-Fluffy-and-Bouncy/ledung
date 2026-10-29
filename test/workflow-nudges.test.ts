// Workflow nudges (#405, approved by Martin 2026-10-29, Ledung question #915): a workflow's nudges file, which
// nudges match a session (role, title prefix, threshold, under it again), a missing or bad file, and no key at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseConfig, parseProject } from '../src/config.ts';
import { contextLine, promptContextLine } from '../src/sessions/management.ts';
import { contextSize } from '../src/shared/context-size.ts';
import { matchingNudges, parseWorkflowNudges, promptNudges, readWorkflowNudges } from '../src/sessions/workflow-nudges.ts';
import { projectWorkflow } from '../src/sessions/workflow.ts';
import type { SessionInfo } from '../src/shared/protocol.ts';
import { removeTemp } from './temp.ts';

// The issue's two examples: the manager's clear at 200k, and a runner-only nudge by title prefix.
const MANAGER_TEXT = 'Over 200k: bring your notes up to date and clear yourself.';
const RUNNER_TEXT = 'Runner over 300k: write your handoff and clear yourself.';
const FILE = {
  $about: 'A comment, ignored like the profiles file\'s.',
  version: 1,
  nudges: [
    { role: 'manager', contextAtLeast: 200000, text: MANAGER_TEXT },
    { $why: 'runners only', role: 'session', titlePrefix: 'win-run-', contextAtLeast: 300000, text: RUNNER_TEXT },
  ],
};

const nudges = () => {
  const read = parseWorkflowNudges('nudges.json', JSON.stringify(FILE));
  assert.equal(read.problem, null);
  return read.problem === null ? read.nudges : [];
};

test('a manager at or over the threshold gets its nudge; under it, or with no size yet, nothing', () => {
  const n = nudges();
  const manager = (contextTokens: number | null) => matchingNudges(n, { role: 'manager', title: 'Manager: Project', contextTokens });
  assert.deepEqual(manager(200_000), [MANAGER_TEXT], 'exactly at the threshold');
  assert.deepEqual(manager(521_000), [MANAGER_TEXT]);
  assert.deepEqual(manager(199_999), []);
  assert.deepEqual(manager(null), [], 'never measured');
  // After a clear the context is small again, and the line is gone.
  assert.deepEqual(manager(12_000), []);
});

test('a session nudge with a title prefix reaches only sessions whose title starts with it, never the manager', () => {
  const n = nudges();
  assert.deepEqual(matchingNudges(n, { role: 'session', title: 'win-run-20261028-day', contextTokens: 801_000 }), [RUNNER_TEXT]);
  assert.deepEqual(matchingNudges(n, { role: 'session', title: 'win-run-20261028-day', contextTokens: 299_000 }), []);
  assert.deepEqual(matchingNudges(n, { role: 'session', title: 'fix-1941', contextTokens: 801_000 }), [], 'another session');
  assert.deepEqual(matchingNudges(n, { role: 'session', title: 'my win-run-x', contextTokens: 801_000 }), [], 'a prefix, not anywhere in the title');
  assert.deepEqual(matchingNudges(n, { role: 'manager', title: 'win-run-manager', contextTokens: 801_000 }), [MANAGER_TEXT], 'the manager gets only its own');
});

test('a session nudge without a prefix reaches every session, and several nudges keep the file order', () => {
  const read = parseWorkflowNudges('n.json', JSON.stringify({ version: 1, nudges: [
    { role: 'session', contextAtLeast: 80000, text: 'Over 80k.' },
    { role: 'session', contextAtLeast: 150000, text: 'Over 150k.' },
  ] }));
  assert.equal(read.problem, null);
  const n = read.problem === null ? read.nudges : [];
  assert.deepEqual(matchingNudges(n, { role: 'session', title: 'anything', contextTokens: 160_000 }), ['Over 80k.', 'Over 150k.']);
  assert.deepEqual(matchingNudges(n, { role: 'session', title: 'anything', contextTokens: 90_000 }), ['Over 80k.']);
  assert.deepEqual(matchingNudges(n, { role: 'manager', title: 'Manager', contextTokens: 160_000 }), []);
});

test('a bad nudges file says what is wrong with it', () => {
  const problem = (text: string | null) => parseWorkflowNudges('n.json', text).problem ?? '';
  assert.equal(problem(null), "The workflow's nudges file n.json was not found.");
  assert.match(problem('{ nope'), /^The workflow's nudges file n\.json is not valid JSON: /);
  assert.match(problem(JSON.stringify({ version: 2, nudges: [] })), /version: version must be 1/);
  assert.match(problem(JSON.stringify({ version: 1, nudges: [{ role: 'worker', contextAtLeast: 1, text: 'x' }] })), /nudges\.0\.role: role must be "manager" or "session"/);
  assert.match(problem(JSON.stringify({ version: 1, nudges: [{ role: 'manager', contextAtLeast: '200k', text: 'x' }] })), /nudges\.0\.contextAtLeast/);
  assert.match(problem(JSON.stringify({ version: 1, nudges: [{ role: 'manager', contextAtLeast: 1, text: ' ' }] })), /nudges\.0\.text/);
  assert.match(problem(JSON.stringify({ version: 1, nudges: [{ role: 'manager', contextAtLeast: 1, text: 'a\nb' }] })), /nudges\.0\.text: text must be one line/);
  // A misspelt key would otherwise be a nudge that silently never matches.
  assert.match(problem(JSON.stringify({ version: 1, nudges: [{ role: 'session', titleprefix: 'win-run-', contextAtLeast: 1, text: 'x' }] })), /nudges\.0/);
});

test('a missing or bad file is told on the prompt, once and again when it changes; a manager is told to report it', () => {
  const manager = { role: 'manager' as const, title: 'Manager', contextTokens: 250_000 };
  let file: string | null = null;
  const read = (f: string) => parseWorkflowNudges(f, file);

  const first = promptNudges('/w/nudges.json', manager, null, read);
  assert.deepEqual(first.lines, ["The workflow's nudges file /w/nudges.json was not found. No nudges are shown until it is fixed. Tell whoever you ask (ask_user) once."]);
  const again = promptNudges('/w/nudges.json', manager, first.told, read);
  assert.deepEqual(again.lines, [], 'not on every prompt');

  file = '{ nope';
  const changed = promptNudges('/w/nudges.json', manager, again.told, read);
  assert.equal(changed.lines.length, 1, 'a different problem is told');
  assert.match(changed.lines[0]!, /is not valid JSON/);

  file = JSON.stringify(FILE);
  const fixed = promptNudges('/w/nudges.json', manager, changed.told, read);
  assert.deepEqual(fixed, { lines: [MANAGER_TEXT], told: null });

  file = null;
  assert.equal(promptNudges('/w/nudges.json', manager, fixed.told, read).lines.length, 1, 'broken again after a fix: told afresh');

  const worker = promptNudges('/w/nudges.json', { role: 'session', title: 'fix-1', contextTokens: 1 }, null, read);
  assert.ok(worker.lines[0]!.endsWith('No nudges are shown until it is fixed.'), 'a worker is told, but not asked to report it');
});

test('without a nudges file in the workflow nothing is read and the prompt is as before', () => {
  const read = () => { throw new Error('nothing should be read'); };
  assert.deepEqual(promptNudges(undefined, { role: 'manager', title: 'M', contextTokens: 900_000 }, null, read), { lines: [], told: null });
  assert.deepEqual(promptNudges('/w/n.json', undefined, null, read), { lines: [], told: null });
});

test('the file is read again when it changes, so an edit counts from the next prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-nudges-'));
  try {
    const file = path.join(dir, 'nudges.json');
    assert.match(readWorkflowNudges(file).problem ?? '', /was not found/);
    fs.writeFileSync(file, JSON.stringify(FILE));
    const before = readWorkflowNudges(file);
    assert.equal(before.problem, null);
    assert.equal(readWorkflowNudges(file), before, 'unchanged: the same read');
    fs.writeFileSync(file, JSON.stringify({ version: 1, nudges: [{ role: 'manager', contextAtLeast: 100000, text: 'Changed, and longer than it was.' }] }));
    const after = readWorkflowNudges(file);
    assert.deepEqual(after.problem === null ? matchingNudges(after.nudges, { role: 'manager', title: 'M', contextTokens: 150_000 }) : after.problem, ['Changed, and longer than it was.']);
  } finally {
    removeTemp(dir);
  }
});

test("the config takes a workflow's nudgesFile, and the project's workflow carries it as a full path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-nudges-'));
  try {
    const workflow = { folder: dir, managerFile: 'lead.md', sessionFile: 'worker.md', projectConfig: 'CFG.md' };
    const config = parseConfig({ workflow: { ...workflow, nudgesFile: 'process/nudges.json' } });
    assert.equal(config.workflow!.nudgesFile, 'process/nudges.json');
    const project = parseProject({ name: 'p', runner: 'local', path: dir });
    assert.equal(projectWorkflow(config.workflow, project)!.nudgesFile, path.resolve(dir, 'process/nudges.json'));
    assert.equal(projectWorkflow(parseConfig({ workflow }).workflow, project)!.nudgesFile, undefined, 'no key: no file');
  } finally {
    removeTemp(dir);
  }
});

test('the prompt line and list_sessions use the shared context size', () => {
  assert.equal(contextSize(142_000, 1_000_000), '142k of 1000k');
  assert.equal(contextSize(12_400, null), '12k');
  assert.equal(promptContextLine({ contextTokens: 142_000, contextWindow: 1_000_000 } as SessionInfo), `Your context: ${contextSize(142_000, 1_000_000)} tokens.`);
  assert.equal(contextLine({ contextTokens: 142_000, contextWindow: 1_000_000 } as SessionInfo), `; context ${contextSize(142_000, 1_000_000)}`);
});
