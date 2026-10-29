// The folder browser: folder names only, and nothing outside the allowed folders, not even through
// a link or junction (projects and accounts, P2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectFolder, isInside, listLocal } from '../src/projects/browse.ts';

function tree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-browse-'));
  const root = path.join(base, 'home');
  const outside = path.join(base, 'secret');
  fs.mkdirSync(path.join(root, 'proj', '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'proj', '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
  fs.mkdirSync(path.join(root, 'notes'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'file.txt'), 'not shown');
  fs.mkdirSync(path.join(outside, 'inner'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  return { base, root, outside };
}

test('lists folders only, with git branches and known projects; no files, no hidden folders', () => {
  const { root } = tree();
  const l = listLocal(undefined, [root], [{ name: 'Mine', path: path.join(root, 'notes') }]);
  assert.deepEqual(l.entries.map((e) => e.name), ['notes', 'proj']);
  assert.equal(l.entries.find((e) => e.name === 'proj')!.git, 'feature/x');
  assert.equal(l.entries.find((e) => e.name === 'notes')!.project, 'Mine');
  assert.equal(l.parent, null);
  assert.equal(listLocal(path.join(root, 'proj'), [root], []).parent, path.join(root));
});

test('nothing outside the allowed folders, not through .. and not through a junction', () => {
  const { root, outside } = tree();
  assert.throws(() => listLocal(path.join(root, '..'), [root], []), /outside/);
  assert.throws(() => listLocal(outside, [root], []), /outside/);
  assert.throws(() => listLocal(path.join(root, 'escape'), [root], []), /outside/);
  assert.equal(isInside(path.join(root, 'escape', 'inner'), [root]), false);
  assert.equal(isInside(path.join(root, 'proj'), [root]), true);
});

test('a new project gets its folder and a git repository; never over an existing folder', async () => {
  const { root, outside } = tree();
  const made = await createProjectFolder(root, 'Project Two', [root], false);
  assert.equal(made.warning, null);
  assert.ok(fs.existsSync(path.join(root, 'Project Two', '.git')));
  await assert.rejects(createProjectFolder(root, 'Project Two', [root], false), /already a folder/);
  await assert.rejects(createProjectFolder(outside, 'x', [root], false), /outside/);
});
