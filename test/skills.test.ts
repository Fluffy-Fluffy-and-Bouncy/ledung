// The skill picker (#300): which of the user's own skills a project's manager and sessions get.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, parseProject, type LocalProjectConfig } from '../src/config.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { SessionManager, UserError } from '../src/sessions/manager.ts';
import { descriptionOf, skillsFromFiles, skillsOff, withSkillsOff } from '../src/sessions/skills.ts';
import { chooseSkill, skillChosen, skillOn } from '../src/shared/skills.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';

test('with nothing chosen anywhere, managers get every skill and sessions none (question #659)', () => {
  assert.equal(skillOn('blocket', 'manager', {}, undefined), true);
  assert.equal(skillOn('blocket', 'session', {}, undefined), false);
  assert.deepEqual(skillsOff(['b', 'a', 'a'], 'session', {}, undefined), ['a', 'b']);
  assert.deepEqual(skillsOff(['a', 'b'], 'manager', {}, undefined), []);
});

test("a project's own choice beats Settings', which beats the new-skills defaults, project's first", () => {
  const defaults = { session: { on: ['notes', 'travel'], newSkills: 'off' as const }, manager: { off: ['cv'] } };
  const project = { session: { off: ['travel'], newSkills: 'on' as const } };
  assert.equal(skillOn('travel', 'session', defaults, project), false, "the project's off over Settings' on");
  assert.equal(skillOn('notes', 'session', defaults, project), true, "Settings' on, the project says nothing");
  assert.equal(skillOn('fresh', 'session', defaults, project), true, "a skill nobody chose: the project's newSkills");
  assert.equal(skillOn('fresh', 'session', defaults, undefined), false, "without the project: Settings' newSkills");
  assert.equal(skillOn('cv', 'manager', defaults, project), false, "Settings' off for managers");
  assert.equal(skillOn('cv', 'manager', defaults, { manager: { on: ['cv'] } }), true);
});

test('choosing a skill keeps the choice even when it equals the default; null goes back to following it', () => {
  let c = chooseSkill({}, 'session', 'notes', true);
  assert.deepEqual(c, { session: { on: ['notes'] } });
  c = chooseSkill(c, 'session', 'notes', false);
  assert.deepEqual(c, { session: { off: ['notes'] } }, 'moved, not in both lists');
  assert.equal(skillChosen(c, 'session', 'notes'), true);
  c = chooseSkill(c, 'session', 'notes', null);
  assert.deepEqual(c, { session: {} });
  assert.equal(skillChosen(c, 'session', 'notes'), false);
});

test("off skills become skillOverrides beside the settings' own; none leaves the settings as they are", () => {
  const own = { skillOverrides: { keep: 'name-only' }, model: 'haiku' };
  assert.deepEqual(withSkillsOff(own, ['a', 'keep']), { model: 'haiku', skillOverrides: { keep: 'off', a: 'off' } });
  assert.equal(withSkillsOff(own, []), own);
  assert.equal(withSkillsOff(undefined, []), undefined);
  assert.deepEqual(withSkillsOff(undefined, ['a']), { skillOverrides: { a: 'off' } });
});

test("a skill that no longer exists is never written: only the skills found go off (#300's Done)", () => {
  // ssh-box was ticked off, then deleted from the computer.
  assert.deepEqual(skillsOff(['notes'], 'manager', {}, { manager: { off: ['ssh-box', 'notes'] } }), ['notes']);
  assert.deepEqual(skillsOff([], 'session', {}, { session: { off: ['ssh-box'] } }), []);
});

test('the skills are the personal and claude.ai ones by folder name; Claude Code\'s hidden folders and other files are left out', () => {
  const md = (d: string) => `---\nname: other\ndescription: ${d}\n---\n# Body`;
  const skills = skillsFromFiles([
    { path: 'skills/blocket/SKILL.md', text: md('Search Blocket. And more.') },
    { path: 'skills/synced/acct/docx/SKILL.md', text: md('"Word files."') },
    { path: 'skills/synced/acct/.trash/SKILL.md', text: md('x') },
    { path: 'skills/.hidden/SKILL.md', text: md('x') },
    { path: 'skills/blocket/README.md', text: md('x') },
    { path: 'skills/synced/SKILL.md', text: md('x') },
    { path: 'skills/synced/acct/blocket/SKILL.md', text: md('a second blocket') },
  ]);
  assert.deepEqual(skills, [
    { name: 'blocket', description: 'Search Blocket.', source: 'personal' },
    { name: 'docx', description: 'Word files.', source: 'claude.ai' },
  ]);
});

test('a description is its first sentence, also from a folded block, and cut when long; none is ""', () => {
  assert.equal(descriptionOf('---\ndescription: >-\n  Folded over\n  two lines. Second.\n---\n'), 'Folded over two lines.');
  assert.equal(descriptionOf('# no front matter'), '');
  assert.equal(descriptionOf(`---\ndescription: ${'x'.repeat(300)}\n---\n`).length, 160);
});

test("the local runner reads the skills from the login folder it's given, personal and synced", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-skills-'));
  try {
    for (const rel of ['skills/notes', 'skills/synced/acct/pdf', 'skills/empty']) fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills/notes/SKILL.md'), '---\ndescription: Notes.\n---\n');
    fs.writeFileSync(path.join(root, 'skills/synced/acct/pdf/SKILL.md'), `---\ndescription: PDF.\n---\n${'x'.repeat(10000)}`);
    const runner = new LocalRunner({ name: 'p', runner: 'local', path: root } as LocalProjectConfig);
    const files = await runner.skillFiles(root);
    assert.deepEqual(files.map((f) => f.path).sort(), ['skills/notes/SKILL.md', 'skills/synced/acct/pdf/SKILL.md'], 'a folder without SKILL.md is not a skill');
    assert.ok(files.every((f) => f.text.length <= 4096), 'only the start is read');
    assert.deepEqual(skillsFromFiles(files).map((s) => `${s.source}:${s.name}`), ['personal:notes', 'claude.ai:pdf']);
    assert.deepEqual(await runner.skillFiles(path.join(root, 'nowhere')), [], 'no skills folder: none');
  } finally {
    removeTemp(root);
  }
});

test("a project keeps its skill choices; Settings' defaults are stored, and choices that can't be used are refused", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-skills-project-'));
  try {
    const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: 'p', runner: 'local', path: folder }] }), new Store(openDatabase(':memory:')), () => {}));
    const p = manager.projects().find((x) => x.name === 'p')!;
    assert.deepEqual(p.skills, {});
    const skills = { manager: { off: ['cv-workshop'] }, session: { on: ['git-crypt'], newSkills: 'off' as const } };
    assert.deepEqual(manager.updateProject('p', { name: 'p', runner: 'local', path: folder, sensitive: p.sensitive, skills } as LocalProjectConfig).skills, skills);
    assert.throws(() => parseProject({ name: 'q', runner: 'local', path: folder, skills: { session: { off: ['bad name'] } } }));
    assert.deepEqual(manager.skillDefaults(), {});
    assert.deepEqual(manager.setSkillDefaults({ session: { on: ['notes'] } }), { session: { on: ['notes'] } });
    assert.deepEqual(manager.skillDefaults(), { session: { on: ['notes'] } });
    assert.throws(() => manager.setSkillDefaults({ session: { newSkills: 'maybe' } }), UserError);
    assert.deepEqual(manager.skillDefaults(), { session: { on: ['notes'] } }, 'a refused change leaves the defaults as they were');
  } finally {
    removeTemp(folder);
  }
});
