import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALWAYS_ASKED_RULE, matchSensitive, routePermission, sensitiveHookOutput, validateSensitive, type SensitiveRules } from '../src/sessions/sensitive.ts';
import { LEDUNG_TOOLS, USER_APPROVED_TOOLS } from '../src/sessions/tools.ts';
import { Management } from '../src/sessions/management.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { unaskedTool } from '../src/sessions/session.ts';
import { parseProject } from '../src/config.ts';
import { SUGGESTIONS, missingSuggestions, withSuggestions } from '../src/shared/sensitive-suggestions.ts';

// A project's list as a new project gets it: the suggestions, as ordinary entries.
const SUGGESTED: SensitiveRules = {
  commandPatterns: SUGGESTIONS.filter((s) => s.kind === 'command').map((s) => s.pattern),
  pathPatterns: SUGGESTIONS.filter((s) => s.kind === 'path').map((s) => s.pattern),
  mcpTools: [],
};
const bash = (command: string, rules: Partial<SensitiveRules> = SUGGESTED) => matchSensitive('Bash', { command }, rules);

test('deploys, infrastructure and publishing are sensitive', () => {
  for (const c of ['kubectl apply -f x.yaml', 'helm upgrade api ./chart', 'terraform apply', 'pulumi up', 'npm publish', 'docker push img:1']) {
    assert.ok(bash(c), c);
  }
});

test('cloud CLIs are sensitive unless obviously read-only', () => {
  assert.ok(bash('aws s3 rm s3://bucket/x'));
  assert.ok(bash('gcloud run deploy api'));
  assert.equal(bash('aws s3 ls s3://bucket'), null);
  assert.equal(bash('az account show'), null);
});

test('pushing to main or force-pushing is sensitive; a feature branch is not', () => {
  assert.ok(bash('git push origin main'));
  assert.ok(bash('git push --force origin feature/x'));
  assert.ok(bash('git push -f'));
  assert.equal(bash('git push origin feature/login'), null);
  assert.equal(bash('git push -u origin fix-123'), null);
});

test("git's -C and -c options before push do not hide a push to main", () => {
  assert.ok(bash('git -C repo push origin main'));
  assert.ok(bash('git -c user.name=x -C ../r push --force'));
  assert.equal(bash('git -C repo push origin feature'), null);
});

test('compound commands: every part is checked', () => {
  assert.ok(bash('cd x && git push origin main'));
  assert.ok(bash('bash -c "git push origin main"'));
  assert.ok(bash('FOO=1 git push origin master'));
  assert.ok(bash('npm test; kubectl get pods'));
  assert.ok(bash('git push origin HEAD:main'));
});

test('ordinary development commands are not sensitive', () => {
  for (const c of ['npm run check', 'npm test', 'git commit -m "x"', 'ls -la', 'node -e "console.log(1)"']) {
    assert.equal(bash(c), null, c);
  }
});

test('secret files are sensitive for file tools', () => {
  const file = (tool: string, file_path: string) => matchSensitive(tool, { file_path }, SUGGESTED);
  assert.ok(file('Read', String.raw`C:\proj\.env`));
  assert.ok(file('Edit', '/app/.env.production'));
  assert.ok(file('Write', '/home/u/.aws/credentials'));
  assert.ok(file('Read', 'certs/server.key'));
  assert.equal(file('Edit', 'src/environment.ts'), null);
  assert.ok(matchSensitive('Grep', { path: '/p/.env', pattern: 'x' }, SUGGESTED));
});

test('there is no hidden list: with an empty list nothing is sensitive', () => {
  assert.equal(bash('git push origin main', {}), null);
  assert.equal(bash('kubectl delete ns prod', { commandPatterns: [], pathPatterns: [], mcpTools: [] }), null);
  assert.equal(matchSensitive('Write', { file_path: '/p/.env' }), null);
});

test('a pattern deleted from the list no longer matches; the others still do', () => {
  const noPush: SensitiveRules = { ...SUGGESTED, commandPatterns: SUGGESTED.commandPatterns.filter((p) => !p.includes('push')) };
  assert.equal(bash('git push origin main', noPush), null);
  assert.ok(bash('kubectl get pods', noPush));
});

test('the rule is named in plain words for a suggested pattern, and shown as the pattern for the user\'s own', () => {
  assert.equal(bash('git push origin main')?.rule, 'Pushing to main or master, or force-pushing');
  assert.equal(matchSensitive('Write', { file_path: 'a/.env' }, SUGGESTED)?.rule, '.env files');
  assert.match(bash('bin/rake db:migrate:prod', { commandPatterns: [String.raw`\bmigrate:prod\b`] })!.rule, /command matches/);
});

test("a project's own patterns work like any entry", () => {
  const project = { commandPatterns: [String.raw`\bmigrate:prod\b`], pathPatterns: [String.raw`config/production\.yml$`], mcpTools: ['mcp__prod__'] };
  assert.ok(bash('bin/rake db:migrate:prod', project));
  assert.ok(matchSensitive('Edit', { file_path: 'app/config/production.yml' }, project));
  assert.ok(matchSensitive('mcp__prod__query', {}, project));
  assert.equal(matchSensitive('mcp__docs__search', {}, project), null);
});

test('invalid patterns are refused with a readable error', () => {
  assert.throws(() => validateSensitive({ commandPatterns: ['(unclosed'] }), /not a valid regular expression/);
});

test('the hook asks for a sensitive call, with the reason, and says nothing otherwise', () => {
  const out = sensitiveHookOutput('Bash', { command: 'cd x && git push origin main' }, SUGGESTED) as { hookSpecificOutput: Record<string, string> };
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason!, /Pushing to main/);
  assert.deepEqual(sensitiveHookOutput('Bash', { command: 'npm test' }, SUGGESTED), {});
  assert.deepEqual(sensitiveHookOutput('Bash', { command: 'git push origin main' }, {}), {});
  assert.equal((sensitiveHookOutput('Write', { file_path: 'x/.env' }, SUGGESTED) as any).hookSpecificOutput.permissionDecision, 'ask');
});

// Issue #37, decision of 2026-10-13: the managers' project tools always reach the user.
test("the managers' project tools are never auto-allowed, while the other Ledung tools are", () => {
  for (const t of ['add_project', 'create_project', 'start_manager', 'stop_manager']) {
    const name = `mcp__ledung__${t}`;
    assert.ok(USER_APPROVED_TOOLS.includes(name), name);
    assert.ok(!LEDUNG_TOOLS.includes(name), `${name} must not pass canUseTool unasked`);
  }
  assert.ok(LEDUNG_TOOLS.includes('mcp__ledung__list_projects'), 'reading the list needs no approval');
  assert.ok(!USER_APPROVED_TOOLS.includes('mcp__ledung__list_projects'));
});

test("the hook asks for a project tool in every mode, whatever the lists say: it doesn't depend on them or the mode", () => {
  for (const rules of [{}, SUGGESTED, { commandPatterns: [], pathPatterns: [], mcpTools: [] }]) {
    const out = sensitiveHookOutput('mcp__ledung__add_project', { name: 'x', folder: '/x' }, rules, USER_APPROVED_TOOLS) as { hookSpecificOutput: Record<string, string> };
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, `Sensitive: ${ALWAYS_ASKED_RULE}`);
  }
  assert.deepEqual(sensitiveHookOutput('mcp__ledung__list_projects', {}, {}, USER_APPROVED_TOOLS), {});
});

test('no grant lifts a project tool: it goes to the user even when a grant covers it', () => {
  const store = new Store(openDatabase(':memory:'));
  const m = new Management({ store } as never);
  store.createSession({ id: 'mgr', project: 'p', runner: 'local', title: 'Manager', parentId: null, permissionMode: 'auto', role: 'manager' });
  for (const t of USER_APPROVED_TOOLS) store.addGrant('mgr', t, undefined, 'user');
  for (const t of USER_APPROVED_TOOLS) {
    const grantFor = () => m.grantFor('mgr', t, {});
    assert.ok(grantFor(), 'the grant does cover the call');
    assert.deepEqual(routePermission(t, {}, {}, USER_APPROVED_TOOLS, grantFor), { sensitive: { rule: ALWAYS_ASKED_RULE } }, t);
  }
  // Control: an ordinary MCP call under the same kind of grant is allowed by it.
  store.addGrant('mgr', 'mcp__other__tool', undefined, 'user');
  assert.ok('grant' in routePermission('mcp__other__tool', {}, {}, USER_APPROVED_TOOLS, () => m.grantFor('mgr', 'mcp__other__tool', {})));
});

// Decision of 2026-10-14: a project can opt its manager out of being asked for the project tools.
test('a project that opted in runs its project tools unasked; every other project still asks', () => {
  for (const t of USER_APPROVED_TOOLS) {
    assert.ok(!unaskedTool(t, USER_APPROVED_TOOLS), `${t} asks by default`);
    assert.ok(unaskedTool(t, []), `${t} runs unasked when opted in`);
    assert.deepEqual(sensitiveHookOutput(t, {}, SUGGESTED, []), {});
  }
  assert.ok(unaskedTool('mcp__ledung__list_projects', USER_APPROVED_TOOLS));
  assert.ok(!unaskedTool('mcp__other__tool', []), 'only Ledung tools are lifted');
  assert.equal(parseProject({ name: 'p', runner: 'local', path: '/x', projectToolsUnasked: true }).projectToolsUnasked, true);
  assert.equal(parseProject({ name: 'p', runner: 'local', path: '/x' }).projectToolsUnasked, undefined);
});

test('a check that fails asks instead of letting the call through', () => {
  const out = sensitiveHookOutput('Bash', { command: 'x' }, { commandPatterns: ['(broken'] }) as { hookSpecificOutput: Record<string, string> };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason!, /could not check/);
});

test('the suggestions: unique names, valid patterns, each matches something and is added without duplicates', () => {
  assert.equal(new Set(SUGGESTIONS.map((s) => s.name)).size, SUGGESTIONS.length);
  validateSensitive(SUGGESTED);
  const once = withSuggestions({ commandPatterns: ['mine'], pathPatterns: [] });
  assert.deepEqual(once.commandPatterns[0], 'mine');
  assert.deepEqual(withSuggestions(once), once);
  assert.equal(missingSuggestions(once.commandPatterns, once.pathPatterns).length, 0);
  const gone = missingSuggestions(SUGGESTED.commandPatterns.slice(1), SUGGESTED.pathPatterns);
  assert.equal(gone.length, 1);
});
