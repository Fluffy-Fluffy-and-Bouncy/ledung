// Accounts show no email or organisation (issue #378): Claude Code reports the computer's own login's email for every
// account (checked 2026-11-18 with `claude auth status --json` on each account's sign-in folder), so Ledung shows only
// what each account's own sign-in check says: how it is signed in, and its plan, which comes from its own sign-in record.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSignIn, type SignIn } from '../src/accounts/signin.ts';
import { parseConfig } from '../src/config.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { removeTemp } from './temp.ts';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-identity-')));
process.env.LEDUNG_DATA_DIR = path.join(base, 'data');
fs.mkdirSync(process.env.LEDUNG_DATA_DIR, { recursive: true });
const made: SessionManager[] = [];
after(() => {
  for (const m of made) m.detachAll();
  removeTemp(base);
});

// What Claude Code 2.1.x prints: the email and organisation are the shared settings' (the same for every account).
const status = (o: Record<string, unknown>) => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'own@example.com', orgName: 'Own Org', ...o });

test("the sign-in check gives the account's plan from its own record, and nothing about who it is", () => {
  const login = readSignIn({ code: 0, stdout: status({ subscriptionType: 'max' }) });
  assert.deepEqual({ ...login, checkedAt: 0 }, { state: 'in', method: 'claude.ai', detail: null, checkedAt: 0, kind: 'login', plan: 'max' });
  const token = readSignIn({ code: 0, stdout: status({ subscriptionType: null }) });
  assert.equal(token.kind, 'token');
  assert.equal(token.plan, null, 'a token in the sign-in store has no plan in its record');
  const out = readSignIn({ code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' });
  assert.equal(out.state, 'out');
  assert.equal(out.plan, undefined);
  assert.ok(!JSON.stringify([login, token]).includes('own@example.com') && !JSON.stringify([login, token]).includes('Own Org'));
});

test('the accounts event shows each account by its own check, with no email or organisation, the default login too', async () => {
  const folder = path.join(base, 'project');
  fs.mkdirSync(folder);
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ userName: 'Simon', projects: [{ name: 'p', runner: 'local', path: folder }] }), new Store(openDatabase(':memory:')), () => {}));
  made.push(manager);
  const plans: Record<string, SignIn> = {
    private: { state: 'in', method: 'claude.ai', kind: 'login', plan: 'pro', detail: null, checkedAt: 1 },
    work: { state: 'in', method: 'claude.ai', kind: 'token', plan: null, detail: null, checkedAt: 1 },
    default: { state: 'in', method: 'claude.ai', kind: 'login', plan: 'max', detail: null, checkedAt: 1 },
  };
  const env: Record<string, string>[] = [];
  manager.checkSignInWith = async (e) => {
    env.push(e);
    const dir = e.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    // By folder: the default's check may carry a sign-in folder of the environment the test runs in.
    const name = dir && path.dirname(dir) === base ? path.basename(dir) : 'default';
    return plans[name] ?? { state: 'out', method: null, detail: null, checkedAt: 1 };
  };
  const priv = manager.addAccount({ name: 'private', configDir: path.join(base, 'private') });
  manager.addAccount({ name: 'work', configDir: path.join(base, 'work') });
  await manager.checkSignIns();
  const event = manager.accountsEvent();
  assert.deepEqual(event.accounts.map((a) => [a.name, a.signInKind, a.plan]), [['private', 'login', 'pro'], ['work', 'token', null]]);
  assert.deepEqual(event.defaultIdentity, { signInKind: 'login', plan: 'max' });
  for (const a of event.accounts) for (const k of ['email', 'organization', 'seenAt']) assert.ok(!(k in a), `no ${k} on ${a.name}`);
  // The check never gets a token, and the project still uses the account it had (none): nothing about that changed.
  assert.ok(env.every((e) => !('CLAUDE_CODE_OAUTH_TOKEN' in e) && !('ANTHROPIC_API_KEY' in e)));
  assert.equal(env.find((e) => e.CLAUDE_SECURESTORAGE_CONFIG_DIR === priv.configDir) !== undefined, true, "each account is checked with its own sign-in folder");
});

test('the update forgets the email and organisation sessions noted, for added accounts and the computer\'s own login', () => {
  const file = path.join(base, 'old.db');
  const db = openDatabase(file);
  const latest = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  db.prepare("INSERT INTO accounts (name, kind, config_dir, email, organization, plan, seen_at, created_at) VALUES ('private', 'folder', '/x', 'work@example.com', 'Work Org', 'max', 5, 1)").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('default-account-identity', '{\"email\":\"work@example.com\"}')").run();
  // Back to before #378's migration, and #395's and #402's after it.
  db.exec(`ALTER TABLE devices DROP COLUMN new_cookie_sealed; ALTER TABLE flow_runs DROP COLUMN retired; ALTER TABLE sessions DROP COLUMN account_switch; ALTER TABLE sessions DROP COLUMN account_chosen; PRAGMA user_version = ${latest - 4}`);
  db.close();
  const again = openDatabase(file);
  assert.deepEqual({ ...again.prepare("SELECT name, config_dir, email, organization, plan, seen_at FROM accounts").get() },
    { name: 'private', config_dir: '/x', email: null, organization: null, plan: null, seen_at: null }, 'the account itself stays');
  assert.equal(again.prepare("SELECT value FROM meta WHERE key = 'default-account-identity'").get(), undefined);
  again.close();
});
