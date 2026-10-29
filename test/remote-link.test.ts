// Join with a code and Leave this relay (issue #237): the join code, what the joining Ledung makes and sends, what it
// saves, and the public name it starts answering to without a restart. The relay's /enrol is stood in for here by a
// small HTTP server; the relay's own side is tested in relay-invite.test.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.ts';
import { isJoinToken, joinCode, JOIN_TOKEN_BYTES, newJoinToken, parseJoinCode } from '../src/remote/join-code.ts';
import { RemoteLink, SAVED_REMOTE, savedRemote, type RemoteServer } from '../src/remote/link.ts';
import type { AcmeClient } from '../src/server/acme.ts';
import { LedungServer } from '../src/server/server.ts';
import { SessionManager } from '../src/sessions/manager.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';
import { refuseRealSignInStores } from './signin-stores.ts';
import { freePort, listenOk } from './free-port.ts';

const TOKEN = newJoinToken(Buffer.alloc(JOIN_TOKEN_BYTES, 0xa5));
const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-join-'));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) removeTemp(dir);
});

test('a join token is 140 random bits in seven groups of four, without I, L, O or U', () => {
  const token = newJoinToken(crypto.randomBytes(JOIN_TOKEN_BYTES));
  assert.match(token, /^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.ok(isJoinToken(token));
  // Every bit counts: two inputs one bit apart give two tokens.
  const a = Buffer.alloc(JOIN_TOKEN_BYTES);
  const b = Buffer.alloc(JOIN_TOKEN_BYTES);
  b[JOIN_TOKEN_BYTES - 1] = 1;
  assert.notEqual(newJoinToken(a), newJoinToken(b));
  assert.throws(() => newJoinToken(Buffer.alloc(16)), /18 random bytes/);
});

test('a join code carries the relay and the token: short for wss://, in full for a relay on this computer', () => {
  assert.equal(joinCode('wss://relay.example.org', TOKEN), `relay.example.org/${TOKEN}`);
  assert.deepEqual(parseJoinCode(`relay.example.org/${TOKEN}`), { relay: 'wss://relay.example.org', enrol: 'https://relay.example.org/enrol', token: TOKEN });
  assert.deepEqual(parseJoinCode(`  wss://relay.example.org:8443/${TOKEN.toLowerCase()}\n`), { relay: 'wss://relay.example.org:8443', enrol: 'https://relay.example.org:8443/enrol', token: TOKEN });
  const local = joinCode('ws://127.0.0.1:9000', TOKEN);
  assert.equal(local, `ws://127.0.0.1:9000/${TOKEN}`);
  assert.deepEqual(parseJoinCode(local), { relay: 'ws://127.0.0.1:9000', enrol: 'http://127.0.0.1:9000/enrol', token: TOKEN });
  for (const bad of ['', 'relay.example.org', `relay.example.org/${TOKEN.slice(0, -1)}`, `relay.example.org/${TOKEN}?x=1`, `ws://relay.example.org/${TOKEN}`, `https://relay.example.org/${TOKEN}`, `relay.example.org/a/${TOKEN}`]) {
    assert.throws(() => parseJoinCode(bad), /join code/, bad);
  }
});

/** A stand-in ACME server's client: one account per key; counts what was asked, and when. */
function fakeAcme(events: string[], fail = false) {
  const known = new Set<string>();
  return (_directory: string, key: Buffer): AcmeClient => {
    const url = `https://acme.test/acct/${crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
    return {
      async createAccount(data) {
        if ('onlyReturnExisting' in data) {
          if (!known.has(url)) throw new Error('accountDoesNotExist');
          return {};
        }
        if (fail) throw new Error('the ACME server is down');
        events.push('acme account');
        known.add(url);
        return {};
      },
      getAccountUrl: () => url,
      createOrder: async () => { throw new Error('no orders in these tests'); },
      getAuthorizations: async () => [],
      getChallengeKeyAuthorization: async () => '',
      completeChallenge: async () => ({}),
      waitForValidStatus: async () => ({}),
      finalizeOrder: async () => { throw new Error('no orders'); },
      getCertificate: async () => '',
    };
  };
}

/** The relay's /enrol, stood in for: records what it gets and answers as the relay does. */
async function fakeEnrol(answer: (body: Record<string, unknown>) => { status: number; body: unknown }, events: string[]) {
  const got: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      events.push(`${req.method} ${req.url}`);
      const body = JSON.parse(text || '{}');
      got.push(body);
      const a = answer(body);
      res.writeHead(a.status, { 'content-type': 'application/json' }).end(JSON.stringify(a.body));
    });
  });
  await listenOk(server);
  const port = (server.address() as net.AddressInfo).port;
  after(() => server.close());
  return { got, code: joinCode(`ws://127.0.0.1:${port}`, TOKEN) };
}

/** A server stand-in recording what the link sets. */
function recorder() {
  const names: (string | null)[] = [];
  const tls: ({ dir: string; required: boolean } | null)[] = [];
  const server: RemoteServer = {
    setPublicName: (name, t) => { names.push(name); tls.push(t); },
    tunnelConnection: () => { throw new Error('no streams in these tests'); },
    setChallenge: () => {},
    loadCertificate: () => {},
    setCertificate: () => {},
    setRemote: () => {},
  };
  return { server, names, tls };
}

test('joining makes the secret and the ACME account here, sends only the hash and the account URL, saves "tls": "required" and starts', async () => {
  const events: string[] = [];
  const enrol = await fakeEnrol(() => ({ status: 200, body: { name: 'copper7meadow4', host: 'copper7meadow4.l.example.org' } }), events);
  const dir = tempDir();
  const { server, names, tls } = recorder();
  const link = new RemoteLink({ server, dir, acmeClient: fakeAcme(events), log: () => {} });
  after(() => link.stop());
  assert.equal(link.source(), null);

  const joined = await link.join(enrol.code);
  assert.equal(joined.publicName, 'copper7meadow4.l.example.org');
  assert.deepEqual(events, ['acme account', 'POST /enrol'], 'the account exists before anything goes to the relay');

  const saved = JSON.parse(fs.readFileSync(path.join(dir, SAVED_REMOTE), 'utf8'));
  assert.equal(saved.relay, enrol.code.slice(0, enrol.code.lastIndexOf('/')));
  assert.equal(saved.name, 'copper7meadow4');
  assert.equal(saved.publicName, 'copper7meadow4.l.example.org');
  assert.equal(saved.tls, 'required');
  assert.equal(saved.acme, 'production');
  assert.ok(saved.secret.length >= 43, 'a 256-bit secret');

  const [sent] = enrol.got;
  assert.deepEqual(Object.keys(sent!).sort(), ['accountUrl', 'code', 'secretSha256']);
  assert.equal(sent!.code, TOKEN);
  assert.equal(sent!.secretSha256, crypto.createHash('sha256').update(saved.secret, 'utf8').digest('hex'), 'the hash the relay checks (relay.ts hashSecret)');
  assert.match(String(sent!.accountUrl), /^https:\/\/acme\.test\/acct\//);
  assert.equal(JSON.stringify(sent).includes(saved.secret), false, 'the secret itself never travels');

  assert.deepEqual(names, ['copper7meadow4.l.example.org'], 'answering to the new name at once, no restart');
  assert.deepEqual(tls, [{ dir, required: true }]);
  assert.equal(link.source(), 'joined');
  assert.deepEqual(savedRemote(dir), parseConfig({ remote: saved }).remote);
  await assert.rejects(link.join(enrol.code), /already on a relay/);
});

test('a refused code saves nothing and answers to no name; an ACME server that is down sends nothing to the relay', async () => {
  const events: string[] = [];
  const enrol = await fakeEnrol(() => ({ status: 400, body: { error: 'This code was used already.' } }), events);
  const dir = tempDir();
  const { server, names } = recorder();
  const link = new RemoteLink({ server, dir, acmeClient: fakeAcme(events), log: () => {} });
  await assert.rejects(link.join(enrol.code), /The relay refused the code: This code was used already\./);
  assert.equal(fs.existsSync(path.join(dir, SAVED_REMOTE)), false);
  assert.deepEqual(names, []);
  assert.equal(link.source(), null);

  const down: string[] = [];
  const quiet = await fakeEnrol(() => ({ status: 200, body: { name: 'x', host: 'x.example.org' } }), down);
  const other = new RemoteLink({ server, dir: tempDir(), acmeClient: fakeAcme(down, true), log: () => {} });
  await assert.rejects(other.join(quiet.code), /ACME account could not be made, so nothing was sent/);
  assert.deepEqual(quiet.got, [], 'nothing reached the relay');
});

test('an ACME server that never answers fails the join within its time limit, and nothing goes to the relay', async () => {
  const events: string[] = [];
  const quiet = await fakeEnrol(() => ({ status: 200, body: { name: 'x', host: 'x.example.org' } }), events);
  const { server, names } = recorder();
  const silent = (directory: string, key: Buffer): AcmeClient => ({ ...fakeAcme(events)(directory, key), createAccount: () => new Promise(() => {}) });
  const link = new RemoteLink({ server, dir: tempDir(), acmeClient: silent, acmeTimeoutMs: 50, log: () => {} });
  await assert.rejects(link.join(quiet.code), /no answer from the ACME server within 0 s/);
  assert.deepEqual(quiet.got, []);
  assert.deepEqual(names, []);
  await assert.rejects(link.join('bad'), /join code/, 'and the next join is not refused as "under way"');
});

test('leaving stops answering to the name and forgets the saved settings; the account key stays', async () => {
  const events: string[] = [];
  const enrol = await fakeEnrol(() => ({ status: 200, body: { name: 'pine4harbor7', host: 'pine4harbor7.l.example.org' } }), events);
  const dir = tempDir();
  const { server, names } = recorder();
  const link = new RemoteLink({ server, dir, acmeClient: fakeAcme(events), log: () => {} });
  await link.join(enrol.code);

  // A restart: the saved settings start the link again, from the data folder.
  const { server: again, names: againNames } = recorder();
  const restarted = new RemoteLink({ server: again, dir, acmeClient: fakeAcme(events), log: () => {} });
  restarted.start();
  assert.deepEqual(againNames, ['pine4harbor7.l.example.org']);
  assert.equal(restarted.source(), 'joined');
  restarted.stop();

  link.leave();
  assert.deepEqual(names, ['pine4harbor7.l.example.org', null]);
  assert.equal(fs.existsSync(path.join(dir, SAVED_REMOTE)), false);
  assert.ok(fs.existsSync(path.join(dir, 'acme-account.key')), 'the account key is this computer\'s, kept');
  assert.equal(link.source(), null);
  assert.throws(() => link.leave(), /not on a relay/);
});

test('the config\'s remote block wins: Join and Leave are refused', async () => {
  const { server } = recorder();
  const link = new RemoteLink({ server, dir: tempDir(), configured: parseConfig({ remote: { relay: 'wss://r.example.org', name: 'pc', publicName: 'pc.example.org', secret: 's' } }).remote, log: () => {} });
  assert.equal(link.source(), 'config');
  await assert.rejects(link.join(`r.example.org/${TOKEN}`), /config file/);
  assert.throws(() => link.leave(), /config file/);
});

test('the server takes a new public name and drops it again without a restart: Host, Origin and CSP follow', async () => {
  const port = await freePort();
  const token = 'b'.repeat(64);
  const store = new Store(openDatabase(':memory:'));
  const manager = refuseRealSignInStores(new SessionManager(parseConfig({ port, projects: [] }), store, () => {}));
  const webRoot = tempDir();
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html>');
  const server = new LedungServer({ port, token, store, manager, webRoot });
  await server.listen();
  after(() => server.close());
  const get = (host: string) => new Promise<{ status: number; csp: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode!, csp: String(res.headers['content-security-policy'] ?? '') });
    }).on('error', reject);
  });
  const name = 'joined.l.example.org';
  assert.equal((await get(name)).status, 403, 'an unknown host before joining');
  server.setPublicName(name, { dir: tempDir(), required: true });
  const joined = await get(name);
  assert.equal(joined.status, 401, 'the public name now: only a paired device gets in');
  assert.match(joined.csp, new RegExp(`wss://${name.replace(/\./g, '\\.')}`));
  server.setPublicName(null, null);
  assert.equal((await get(name)).status, 403, 'an unknown host again after leaving');
  assert.doesNotMatch((await get(`127.0.0.1:${port}`)).csp, /wss:/);
});
