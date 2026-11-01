// A linked computer's tab keeps its Settings → Look choices (issue #459): on an iPhone the framed page's own storage
// is not kept, so the page that frames it keeps them, per computer, and hands them back when the frame loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  answeredSettings, frameSettingsAsk, frameSettingsKey, frameSettingsReply, keptSettings, mirroredStore, ownSettings,
  takeSettings, type FrameSettingsMessage, type SettingsStore,
} from '../web/src/frameSettings.ts';
import { THEME_KEY, readTheme, saveTheme } from '../web/src/theme.ts';
import { COMPACT_KEY, readCompact, saveCompact } from '../web/src/compactSidebar.ts';
import { readStatusDot, saveStatusDot } from '../web/src/statusDot.ts';

function memoryStore(): SettingsStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

// The phone with two computers (the issue's evidence): the first computer's page frames the second's.
const SECOND_URL = 'https://second.l.example.test';
const SECOND_ID = 'second.l.example.test';
const SECOND_ORIGIN = new URL(SECOND_URL).origin;

/** The framing page (the first computer's, on the phone): its storage is kept. */
const framing = memoryStore();

/** The second computer's page in the frame: a fresh storage on each load, as WebKit's ephemeral third-party storage is. */
function loadFrame() {
  const own = memoryStore();
  const fromFrame = (msg: FrameSettingsMessage) => frameSettingsReply({ data: msg, origin: SECOND_ORIGIN, fromFrame: true }, SECOND_URL, SECOND_ID, framing);
  const store = mirroredStore(() => own, (msg) => { fromFrame(msg); });
  // The frame asks as it starts and takes the answer (settingsStore.ts, followFramingPage).
  const settings = answeredSettings(fromFrame(frameSettingsAsk()), true);
  assert.notEqual(settings, undefined, 'the framing page answers its own frame');
  if (settings === null) for (const save of ownSettings(own)) fromFrame(save);
  else takeSettings(own, settings!);
  return { own, store };
}

test('a choice made in a linked computer\'s tab is still there after the frame loads again', () => {
  const first = loadFrame();
  saveTheme(first.store, 'dark');
  saveCompact(first.store, 3);
  saveStatusDot(first.store, false);
  assert.equal(readTheme(first.own), 'dark', 'applies at once in the frame');

  const again = loadFrame();
  assert.equal(readTheme(again.own), 'dark');
  assert.equal(readCompact(again.own), 3);
  assert.equal(readStatusDot(again.own), false);

  // Back to a default removes it there too, so the next load does not bring the old choice back.
  saveTheme(again.store, 'system');
  assert.equal(readTheme(loadFrame().own), 'system');
});

test('the framing page keeps each computer\'s choices apart from its own', () => {
  const page = memoryStore();
  saveTheme(page, 'light'); // the framing page's own theme
  const reply = (data: unknown, id: string, url: string) => frameSettingsReply({ data, origin: new URL(url).origin, fromFrame: true }, url, id, page);
  reply({ type: 'ledung:setting', key: THEME_KEY, value: 'dark' }, 'a.example.test', 'https://a.example.test');
  assert.equal(readTheme(page), 'light', 'its own theme is untouched');
  assert.deepEqual(keptSettings(page, 'a.example.test'), { [THEME_KEY]: 'dark' });
  assert.equal(keptSettings(page, 'b.example.test'), null);
  assert.deepEqual(reply(frameSettingsAsk(), 'b.example.test', 'https://b.example.test'), { type: 'ledung:settings', settings: null });
});

test('only that computer\'s frame, at its address, is answered or kept', () => {
  const page = memoryStore();
  const save = { type: 'ledung:setting', key: THEME_KEY, value: 'dark' };
  // Another window (not that frame), or that frame's window at another address (it navigated away).
  for (const msg of [
    { data: save, origin: SECOND_ORIGIN, fromFrame: false },
    { data: save, origin: 'https://evil.example.test', fromFrame: true },
    { data: save, origin: 'http://second.l.example.test', fromFrame: true },
  ]) {
    assert.equal(frameSettingsReply(msg, SECOND_URL, SECOND_ID, page), null);
    assert.equal(frameSettingsReply({ ...msg, data: frameSettingsAsk() }, SECOND_URL, SECOND_ID, page), null, 'nothing answered');
  }
  assert.equal(page.data.size, 0, 'nothing kept');
  // The frame takes an answer only from the page that frames it.
  assert.equal(answeredSettings({ type: 'ledung:settings', settings: { [THEME_KEY]: 'dark' } }, false), undefined);
  assert.equal(answeredSettings('ledung:paired', true), undefined, 'the pairing answer is something else');
});

test('only Settings → Look\'s choices pass, with short values', () => {
  const page = memoryStore();
  const reply = (data: unknown) => frameSettingsReply({ data, origin: SECOND_ORIGIN, fromFrame: true }, SECOND_URL, SECOND_ID, page);
  reply({ type: 'ledung:setting', key: 'ledung.draft.s1', value: 'a draft' });
  reply({ type: 'ledung:setting', key: 'ledung.theme', value: 'x'.repeat(100) });
  reply({ type: 'ledung:setting', key: 'ledung.theme', value: 42 });
  assert.equal(page.data.size, 0);
  // A tampered entry in the page's own storage passes only its known settings back.
  page.setItem(frameSettingsKey(SECOND_ID), JSON.stringify({ [COMPACT_KEY]: '2', other: 'x', [THEME_KEY]: 7 }));
  assert.deepEqual(answeredSettings(reply(frameSettingsAsk()), true), { [COMPACT_KEY]: '2' });
  page.setItem(frameSettingsKey(SECOND_ID), 'not json');
  assert.equal(keptSettings(page, SECOND_ID), null);
  // In the frame, saving anything else sends nothing.
  const sent: FrameSettingsMessage[] = [];
  const store = mirroredStore(() => memoryStore(), (m) => { sent.push(m); });
  store.setItem('ledung.sidebar.x', '200');
  store.removeItem('ledung.limitAccount');
  assert.deepEqual(sent, []);
});

test('the first time, a frame whose own storage was kept hands its choices up instead of losing them', () => {
  const kept = memoryStore();
  saveTheme(kept, 'dark');
  saveCompact(kept, 2);
  kept.setItem('ledung.sidebar.x', '200');
  assert.deepEqual(ownSettings(kept).map((m) => m.type === 'ledung:setting' && m.key).sort(), [COMPACT_KEY, THEME_KEY].sort());
});

test('Settings → Look saves through the store the framing page follows, and both sides are wired', () => {
  const read = (p: string) => readFileSync(new URL(`../web/src/${p}`, import.meta.url), 'utf8');
  for (const [file, save] of [
    ['components/SettingsView.tsx', 'saveTheme'], ['useCompactSidebar.ts', 'saveCompact'], ['useStatusDot.ts', 'saveStatusDot'],
    ['usePlainTyping.ts', 'saveAutocorrect'], ['useArchivedLink.ts', 'saveArchivedLink'],
  ] as const) {
    const src = read(file);
    assert.match(src, new RegExp(`${save}\\(settingsStore, `), `${file} saves through settingsStore`);
    assert.doesNotMatch(src, new RegExp(`${save}\\(localStorage`), `${file} no longer saves past it`);
  }
  assert.match(read('main.tsx'), /^followFramingPage\(\);$/m, 'the frame asks as the page starts');
  assert.match(read('main.tsx'), /e\.key === null\) applyTheme\(document\.documentElement, readTheme\(localStorage\)\)/, 'and the theme follows the answer');
  const tabs = read('components/ComputerTabs.tsx');
  // The framing page's handler hands each message to frameMessage (frame-settings-wiring.test.ts runs it).
  assert.match(tabs, /if \(!frameMessage\(msg, \{ id: c\.id, url: c\.url! \}, localStorage, reply\)\) continue;/, 'the framing page answers each computer\'s frame');
  assert.match(tabs, /fromFrame: e\.source === frames\.current\[c\.id\]\?\.contentWindow/);
  assert.match(tabs, /\(e\.source as Window\)\.postMessage\(answer, e\.origin\)/, 'only to that frame, at the origin it came from');
});
