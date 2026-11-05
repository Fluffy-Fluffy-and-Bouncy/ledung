// Images in the message box (issue #128): checked by their bytes, kept under their session with Ledung's own names,
// and sent to Claude Code as image blocks before the text, also when the message waits for a free place or joins a turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ChatImages, chatImageType, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES } from '../src/sessions/chat-images.ts';
import { LocalRunner } from '../src/runners/local-runner.ts';
import { Session } from '../src/sessions/session.ts';
import { openDatabase } from '../src/store/database.ts';
import { Store } from '../src/store/store.ts';
import { removeTemp } from './temp.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from('GIF89a\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-chat-images-'));

test('only PNG, JPEG, GIF and WebP pass, by their first bytes', () => {
  assert.equal(chatImageType(PNG), 'image/png');
  assert.equal(chatImageType(JPEG), 'image/jpeg');
  assert.equal(chatImageType(GIF), 'image/gif');
  assert.equal(chatImageType(WEBP), 'image/webp');
  for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<!doctype html><script>x</script>', 'RIFF....WAVE', '%PDF-1.7', '']) {
    assert.equal(chatImageType(Buffer.from(bad, 'latin1')), null, bad);
  }
});

test('an image is kept with its own random name and read back only by it, only for its session', () => {
  const dir = tmp();
  const images = new ChatImages(dir);
  const { id, type } = images.save('s1', WEBP);
  assert.match(id, /^[0-9a-f]{32}\.webp$/);
  assert.equal(type, 'image/webp');
  assert.deepEqual(images.read('s1', id).bytes, WEBP);
  assert.throws(() => images.read('s2', id), /no longer there/);
  assert.throws(() => images.read('s1', `../s1/${id}`), /Not an image/);
  assert.throws(() => images.read('../x', id), /Not a session/);
  assert.throws(() => images.save('s1', Buffer.from('<svg/>')), /PNG, JPEG, GIF and WebP/);
  assert.throws(() => images.save('s1', Buffer.alloc(MAX_CHAT_IMAGE_BYTES + 1, PNG)), /too large/);
  // A file whose bytes no longer match its name's type is not served.
  fs.writeFileSync(path.join(dir, 's1', id), '<svg/>');
  assert.throws(() => images.read('s1', id), /Not an image/);
  assert.deepEqual(images.check('s1', undefined), []);
  assert.throws(() => images.check('s1', Array(MAX_CHAT_IMAGES + 1).fill(id)), /At most/);
  assert.throws(() => images.check('s1', ['../../ledung.db']), /not one of this session/);
  removeTemp(dir);
});

async function session(images: ChatImages, mayStart: () => boolean) {
  const store = new Store(openDatabase(':memory:'));
  const info = store.createSession({ id: 's1', project: 'p', runner: 'local', title: 'Worker', parentId: null, permissionMode: 'default', role: 'session' });
  let prompt: AsyncIterable<SDKUserMessage> | null = null;
  const stream = {
    accountInfo: async () => ({}),
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => {}) }),
  };
  const s = new Session({
    info, store, publish: () => {}, userName: 'Simon', images,
    management: new Proxy({}, { get: (_, k) => (k === 'questionTiers' ? () => [] : () => undefined) }) as never,
    runner: new LocalRunner({ name: 'p', runner: 'local', path: os.tmpdir() } as never),
    gate: { mayStart, started: () => {}, ended: () => {} },
    query: ((args: { prompt: AsyncIterable<SDKUserMessage> }) => { prompt = args.prompt; return stream; }) as never,
  });
  await s.start();
  return { s, store, sent: prompt![Symbol.asyncIterator]() };
}

test('a message waiting for a free place keeps its images; they go to Claude Code as blocks before its text', async () => {
  const dir = tmp();
  const images = new ChatImages(dir);
  let free = false;
  const { s, store, sent } = await session(images, () => free);
  const a = images.save('s1', PNG).id;
  const b = images.save('s1', JPEG).id;
  s.send('what is this?', false, [a, b]);
  assert.equal(store.getSession('s1')!.status, 'queued');
  assert.deepEqual(store.heldMessages('s1'), [{ text: 'what is this?', images: [a, b] }]);
  const shown = store.listMessages('s1', { limit: 10 }).find((m) => m.kind === 'user')!;
  assert.deepEqual(shown.data, { text: 'what is this?', images: [a, b] }, 'the history names them, never their bytes');
  free = true;
  s.deliver();
  const m = (await sent.next()).value as SDKUserMessage;
  assert.deepEqual(m.message.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG.toString('base64') } },
    { type: 'text', text: 'what is this?' },
  ]);
  removeTemp(dir);
});

test('during a turn a message with an image joins it at once, an image alone too', async () => {
  const dir = tmp();
  const images = new ChatImages(dir);
  const { s, store, sent } = await session(images, () => true);
  s.send('start');
  assert.equal((await sent.next()).value!.message.content, 'start');
  assert.equal(store.getSession('s1')!.status, 'running');
  const id = images.save('s1', GIF).id;
  s.send('', false, [id]);
  assert.deepEqual(((await sent.next()).value as SDKUserMessage).message.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: GIF.toString('base64') } },
  ]);
  removeTemp(dir);
});
