// What no session may read or change (#104): Ledung's data folder and the hosts' sockets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { boundarySettings, deniedPaths, rulePath, withBoundary } from '../src/sessions/boundary.ts';

const same = (p: string) => p;

test('rules write absolute paths with // and Windows paths in their POSIX form', () => {
  assert.equal(rulePath('/Users/me/Library/Application Support/Ledung', 'darwin'), '//Users/me/Library/Application Support/Ledung');
  // The permissions docs: "C:\Users\alice becomes /c/Users/alice", so a rule is //c/Users/alice.
  assert.equal(rulePath('C:\\Users\\me\\AppData\\Roaming\\Ledung', 'win32'), '//c/Users/me/AppData/Roaming/Ledung');
});

test('the whole data folder is denied, to file tools and to sandboxed commands, with the hosts\' sockets', () => {
  const b = boundarySettings({ dataDir: '/data/Ledung', ownLoginFolder: null, platform: 'darwin', realpath: same, socketDir: '/tmp' });
  for (const rule of ['Read(//data/Ledung)', 'Read(//data/Ledung/**)', 'Edit(//data/Ledung)', 'Edit(//data/Ledung/**)', 'Read(//tmp/ledung-host-*)', 'Edit(//tmp/ledung-host-*)']) {
    assert.ok(b.permissions.deny.includes(rule), rule);
  }
  assert.deepEqual(b.sandbox?.filesystem.denyRead.sort(), ['/data/Ledung', '/tmp/ledung-host-*']);
});

test('a folder reached through a link is denied by its real path too (macOS: /tmp is /private/tmp)', () => {
  const b = boundarySettings({ dataDir: '/tmp/x/data', ownLoginFolder: null, platform: 'darwin', realpath: (p) => p.replace(/^\/tmp/, '/private/tmp'), socketDir: '/tmp' });
  assert.ok(b.permissions.deny.includes('Read(//private/tmp/x/data/**)'));
  assert.ok(b.sandbox?.filesystem.denyRead.includes('/private/tmp/ledung-host-*'));
});

test('on Windows the file tools are denied; there is no sandbox there', () => {
  const b = boundarySettings({ dataDir: 'C:\\Users\\me\\AppData\\Roaming\\Ledung', ownLoginFolder: null, platform: 'win32', realpath: same });
  assert.ok(b.permissions.deny.includes('Read(//c/Users/me/AppData/Roaming/Ledung/**)'));
  assert.equal(b.sandbox, undefined);
});

test('a session keeps its own login folder inside the data folder, and nothing beside it', () => {
  // In this computer's own path form, as Ledung gets them.
  const data = path.resolve('/data');
  const listing: Record<string, string[]> = {
    [data]: ['auth-token', 'ledung.db', 'hosts', 'accounts', 'app'],
    [path.join(data, 'accounts')]: ['work', 'home', 'home.token'],
  };
  const denied = deniedPaths(data, path.join(data, 'accounts', 'work'), (d) => listing[d] ?? []);
  for (const p of ['auth-token', 'ledung.db', 'ledung.db*', 'hosts', 'app', 'accounts/home', 'accounts/home.token', 'accounts/*.token']) {
    assert.ok(denied.includes(path.join(data, p)), p);
  }
  assert.ok(!denied.includes(data), 'not the whole folder');
  assert.ok(!denied.includes(path.join(data, 'accounts')), 'not the way down');
  assert.ok(!denied.includes(path.join(data, 'accounts', 'work')), 'not its own login folder');
  // A login folder elsewhere changes nothing: the whole folder.
  assert.deepEqual(deniedPaths(data, path.resolve('/home/me/.claude')), [data]);
});

test("the boundary is added to a settings file's own rules, which stay", () => {
  const b = boundarySettings({ dataDir: '/d', ownLoginFolder: null, platform: 'linux', realpath: same, socketDir: '/tmp' });
  const merged = withBoundary({ model: 'haiku', permissions: { deny: ['Bash(rm:*)'], allow: ['Read'] }, sandbox: { enabled: true, filesystem: { denyRead: ['~/.aws'] } } }, b);
  assert.equal(merged.model, 'haiku');
  const permissions = merged.permissions as { deny: string[]; allow: string[] };
  assert.deepEqual(permissions.allow, ['Read']);
  assert.equal(permissions.deny[0], 'Bash(rm:*)');
  assert.ok(permissions.deny.includes('Read(//d/**)'));
  const sandbox = merged.sandbox as { enabled: boolean; filesystem: { denyRead: string[] } };
  assert.equal(sandbox.enabled, true);
  assert.deepEqual(sandbox.filesystem.denyRead.slice(0, 2), ['~/.aws', '/d']);
  // Without settings of its own a session still gets the boundary.
  assert.ok((withBoundary(undefined, b).permissions as { deny: string[] }).deny.includes('Edit(//d/**)'));
});
