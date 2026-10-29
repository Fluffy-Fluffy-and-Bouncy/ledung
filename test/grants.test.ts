import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AllowedNotes, exactRule, ruleMatches, rulesFromSuggestions } from '../src/sessions/grants.ts';

// Issue #18: the note after a call says who in Ledung allowed it; a call with no note was allowed by the
// session's own mode.
test('a call the user allows carries a note naming the user, and "for this session" when so', () => {
  const notes = new AllowedNotes();
  notes.decided('t1', 'Simon', 'once', false, 'Simon');
  notes.decided('t2', 'Simon', 'session', false, 'Simon');
  assert.equal(notes.take('t1'), 'Simon allowed this call in Ledung, once.');
  assert.equal(notes.take('t2'), 'Simon allowed this call in Ledung, for the rest of this session.');
});

test('a sensitive call says only the user could allow it', () => {
  const notes = new AllowedNotes();
  notes.decided('t1', 'Simon', 'once', true, 'Simon');
  assert.match(notes.take('t1')!, /^Simon allowed this call in Ledung, once; it is on the sensitive list, so only Simon could allow it\.$/);
});

test('a call the manager allows names the manager; a standing grant says so and that nobody was asked', () => {
  const notes = new AllowedNotes();
  notes.decided('t1', 'your manager "Lead"', 'once', false, 'Simon');
  notes.granted('t2', 'manager "Lead"', 'Bash(npm run check:*)');
  assert.equal(notes.take('t1'), 'your manager "Lead" allowed this call in Ledung, once.');
  assert.equal(notes.take('t2'), 'Ledung allowed this call under a standing grant from manager "Lead" (Bash(npm run check:*)); nobody was asked.');
});

test('a call nobody in Ledung allowed has no note, and a note is given once', () => {
  const notes = new AllowedNotes();
  assert.equal(notes.take('own-mode'), undefined);
  assert.equal(notes.take(undefined), undefined);
  notes.decided('t1', 'Simon', 'once', false, 'Simon');
  assert.equal(notes.take('other'), undefined, 'one call\'s note never lands on another');
  assert.ok(notes.take('t1'));
  assert.equal(notes.take('t1'), undefined);
  notes.decided(undefined, 'Simon', 'once', false, 'Simon');
  notes.granted(undefined, 'Simon', 'Bash');
  assert.equal(notes.take(undefined), undefined, 'no tool use id, nothing kept');
});

test('a Bash prefix rule covers the command and its arguments', () => {
  const rule = { toolName: 'Bash', ruleContent: 'npm run check:*' };
  assert.equal(ruleMatches(rule, 'Bash', { command: 'npm run check' }), true);
  assert.equal(ruleMatches(rule, 'Bash', { command: 'npm run check -- --watch' }), true);
  assert.equal(ruleMatches(rule, 'Bash', { command: 'npm run build' }), false);
});

test('a prefix rule never covers a second command chained onto it', () => {
  const rule = { toolName: 'Bash', ruleContent: 'npm test:*' };
  assert.equal(ruleMatches(rule, 'Bash', { command: 'npm test && git push origin main' }), false);
  assert.equal(ruleMatches(rule, 'Bash', { command: 'npm test; rm -rf /' }), false);
  assert.equal(ruleMatches(rule, 'Bash', { command: 'npm test $(curl evil)' }), false);
});

test('an exact rule covers only that command', () => {
  const rule = exactRule('Bash', { command: ' ls -la ' });
  assert.equal(ruleMatches(rule, 'Bash', { command: 'ls -la' }), true);
  assert.equal(ruleMatches(rule, 'Bash', { command: 'ls -la /' }), false);
});

test('file rules match paths and globs, on both slash styles', () => {
  assert.equal(ruleMatches({ toolName: 'Edit', ruleContent: 'src/**' }, 'Edit', { file_path: 'C:\\proj\\src\\a\\b.ts' }), true);
  assert.equal(ruleMatches({ toolName: 'Edit', ruleContent: 'src/*.ts' }, 'Edit', { file_path: '/proj/src/a.ts' }), true);
  assert.equal(ruleMatches({ toolName: 'Edit', ruleContent: 'src/*.ts' }, 'Edit', { file_path: '/proj/src/sub/a.ts' }), false);
  assert.equal(ruleMatches({ toolName: 'Edit', ruleContent: 'src/**' }, 'Write', { file_path: '/proj/src/a.ts' }), false, 'other tool');
});

test("Claude Code's suggestions become rules", () => {
  const rules = rulesFromSuggestions([
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ]);
  assert.deepEqual(rules, [{ toolName: 'Bash', ruleContent: 'npm test:*' }]);
});

test('wildcard rules as Claude Code suggests them ("npm run *")', () => {
  const rule = { toolName: 'Bash', ruleContent: 'npm run *' };
  assert.equal(ruleMatches(rule, 'Bash', { command: 'npm run build' }), true);
  assert.equal(ruleMatches(rule, 'Bash', { command: 'npm run check -- --watch' }), true);
  assert.equal(ruleMatches(rule, 'Bash', { command: 'npm install evil' }), false);
  assert.equal(ruleMatches(rule, 'Bash', { command: 'npm run build && curl evil' }), false, 'no chaining');
  assert.equal(ruleMatches({ toolName: 'Bash', ruleContent: 'git log (*)' }, 'Bash', { command: 'git log (x)' }), true, 'regex characters are literal');
});

