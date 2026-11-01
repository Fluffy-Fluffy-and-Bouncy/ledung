// A linked computer's tab keeps its Settings → Look choices (issue #459): the page's wiring to the browser, not just the
// rule (test review of PR #12, finding 1). The real settingsStore.ts is loaded against a stub browser in a frame
// (window, parent, top, localStorage, StorageEvent) and given the framing page's answers; the framing page's side runs
// through frameMessage, the one call ComputerFrames makes for each message. Each test loads its own copy of the module
// (a query on its address), since it keeps the framing page's origin from when it loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameMessage, frameSettingsAsk, frameSettingsKey, type FrameSettingsMessage, type SettingsStore } from '../web/src/frameSettings.ts';
import { THEME_KEY, readTheme, saveTheme } from '../web/src/theme.ts';
import { COMPACT_KEY, readCompact } from '../web/src/compactSidebar.ts';
import { STATUS_DOT_KEY } from '../web/src/statusDot.ts';
import { frameAsk } from '../web/src/computerFrame.ts';

type Module = typeof import('../web/src/settingsStore.ts');
let loads = 0;

// The phone with two computers (the issue's evidence): the first computer's page frames the second's.
const FIRST = 'https://first.l.example.test';
const SECOND = { id: 'second.l.example.test', url: 'https://second.l.example.test' };

function memoryStore(data = new Map<string, string>()): SettingsStore & { data: Map<string, string> } {
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

class FakeStorageEvent extends Event {
  readonly key: string | null;
  constructor(type: string, init: { key?: string | null } = {}) {
    super(type);
    this.key = init.key ?? null;
  }
}

/**
 * The framed page as the browser starts it: its own storage (fresh each load, as WebKit's ephemeral third-party one
 * is), a parent window whose postMessage goes to `toParent`, and the module's followFramingPage run as main.tsx does.
 */
async function loadFrame(toParent: (msg: unknown, targetOrigin: string) => void, own = memoryStore()) {
  const g = globalThis as unknown as Record<string, unknown>;
  const parent = { postMessage: toParent };
  const win = Object.assign(new EventTarget(), { parent });
  g.window = win;
  g.localStorage = own;
  g.StorageEvent = FakeStorageEvent;
  // In a frame: inFrame() compares self with top.
  Object.defineProperty(globalThis, 'self', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'top', { configurable: true, value: parent });
  const storageEvents: (string | null)[] = [];
  win.addEventListener('storage', (e) => storageEvents.push((e as FakeStorageEvent).key));
  /** A message to the framed page, by default from its parent at the first computer's origin. */
  const message = (data: unknown, origin = FIRST, source: unknown = parent) =>
    win.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }));
  const mod = (await import(`../web/src/settingsStore.ts?load=${++loads}`)) as Module;
  return { ...mod, own, parent, message, storageEvents };
}

test('the framed page asks as it starts, takes the answer and re-reads it, then sends saves only to the page that answered', async () => {
  const posted: { msg: unknown; origin: string }[] = [];
  const own = memoryStore();
  own.setItem(STATUS_DOT_KEY, '0'); // left from earlier in this visit; the framing page keeps no such choice
  const frame = await loadFrame((msg, origin) => posted.push({ msg, origin }), own);
  frame.followFramingPage();
  assert.deepEqual(posted, [{ msg: frameSettingsAsk(), origin: '*' }], 'asks the page that frames it, with nothing in the ask');

  // Before an answer nothing is sent: there is no framing origin to send to.
  saveTheme(frame.settingsStore, 'light');
  assert.equal(posted.length, 1);

  // An answer from any other window is not taken.
  frame.message({ type: 'ledung:settings', settings: { [THEME_KEY]: 'dark' } }, 'https://evil.example.test', {});
  assert.equal(readTheme(own), 'light');
  assert.deepEqual(frame.storageEvents, []);

  frame.message({ type: 'ledung:settings', settings: { [THEME_KEY]: 'dark', [COMPACT_KEY]: '3' } });
  assert.equal(readTheme(own), 'dark', 'the framing page\'s choices are in this page\'s storage');
  assert.equal(readCompact(own), 3);
  assert.equal(own.getItem(STATUS_DOT_KEY), null, 'one it does not keep is back to its default');
  assert.deepEqual(frame.storageEvents, [null], 'and the theme and sidebar re-read them at once');

  saveTheme(frame.settingsStore, 'light');
  assert.deepEqual(posted.slice(1), [{ msg: { type: 'ledung:setting', key: THEME_KEY, value: 'light' }, origin: FIRST }], 'sent up to the origin that answered');
  assert.equal(readTheme(own), 'light', 'and saved here as before');
});

test('a framing page that keeps none yet gets this page\'s own choices', async () => {
  const posted: { msg: unknown; origin: string }[] = [];
  const own = memoryStore();
  saveTheme(own, 'dark'); // a desktop frame's storage, which was kept
  const frame = await loadFrame((msg, origin) => posted.push({ msg, origin }), own);
  frame.followFramingPage();
  frame.message({ type: 'ledung:settings', settings: null });
  assert.deepEqual(posted.slice(1), [{ msg: { type: 'ledung:setting', key: THEME_KEY, value: 'dark' }, origin: FIRST }]);
  assert.equal(readTheme(own), 'dark', 'nothing lost here');
});

test('a page not in a frame asks nothing and sends nothing', async () => {
  const posted: unknown[] = [];
  const frame = await loadFrame((msg) => posted.push(msg));
  Object.defineProperty(globalThis, 'top', { configurable: true, value: globalThis.self });
  frame.followFramingPage();
  saveTheme(frame.settingsStore, 'dark');
  assert.deepEqual(posted, []);
  assert.equal(readTheme(frame.own), 'dark');
});

test('the framing page answers only its frame and still hears "paired"', () => {
  const page = memoryStore();
  const answers: FrameSettingsMessage[] = [];
  const reply = (a: FrameSettingsMessage) => { answers.push(a); };
  const fromSecond = (data: unknown, fromFrame = true, origin = SECOND.url) => frameMessage({ data, origin, fromFrame }, SECOND, page, reply);
  assert.equal(fromSecond(frameSettingsAsk()), false);
  assert.deepEqual(answers, [{ type: 'ledung:settings', settings: null }]);
  assert.equal(fromSecond({ type: 'ledung:setting', key: THEME_KEY, value: 'dark' }), false);
  assert.equal(page.getItem(frameSettingsKey(SECOND.id)), JSON.stringify({ [THEME_KEY]: 'dark' }));
  assert.equal(fromSecond('ledung:paired'), true, 'the frame saying it is paired (#286)');
  assert.equal(fromSecond('ledung:paired', false), false, 'not from that frame\'s window');
  assert.equal(fromSecond(frameSettingsAsk(), false), false);
  assert.equal(fromSecond(frameSettingsAsk(), true, 'https://evil.example.test'), false);
  assert.equal(answers.length, 1, 'answered once, to that frame only');
  assert.equal(fromSecond(frameAsk()), false, 'the framing page\'s own question is not an answer');
});

test('end to end: a choice made in the tab comes back after the frame\'s storage is dropped and it loads again', async () => {
  const page = memoryStore(); // the first computer's page on the phone: kept
  let frame!: Awaited<ReturnType<typeof loadFrame>>;
  // What the frame posts reaches the framing page from that frame's window at the second computer's origin; its answer comes back.
  const toParent = (msg: unknown, targetOrigin: string) => {
    if (targetOrigin !== '*' && targetOrigin !== FIRST) return; // the browser drops a message for another origin
    frameMessage({ data: msg, origin: SECOND.url, fromFrame: true }, SECOND, page, (answer) => frame.message(answer));
  };
  frame = await loadFrame(toParent);
  frame.followFramingPage();
  saveTheme(frame.settingsStore, 'dark');

  frame = await loadFrame(toParent); // reopened: a fresh, empty storage
  frame.followFramingPage();
  assert.equal(readTheme(frame.own), 'dark');
  assert.deepEqual(frame.storageEvents, [null]);
});
