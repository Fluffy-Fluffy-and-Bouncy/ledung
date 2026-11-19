// The install box on projectledung.com (#436): the Copy button and the version line, run as the browser
// would run site/assets/install.js, with the page reduced to what the script touches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { appDir } from '../src/platform/paths.ts';

interface Button { textContent: string; classList: { has(c: string): boolean }; click(): Promise<void> }
interface Box {
  line: { textContent: string };
  status: { textContent: string };
  button: Button;
  fetched: string[];
  copied: string[];
  timers: Array<() => void>;
}
interface Options {
  fetch?: (url: string) => Promise<unknown>;
  writeText?: (text: string) => Promise<void>;
  execCommand?: (command: string, selected: string) => boolean;
}

// Lets the script's promise chains run to the end (they are short: fetch, json, then).
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function installBox(options: Options = {}): Box {
  // The text the page ships with, before the script runs.
  const line = { textContent: 'Ledung on npm' };
  const status = { textContent: '' };
  const classes = new Set<string>();
  let onClick: () => Promise<void> = async () => {};
  const button = {
    textContent: 'Copy',
    classList: {
      has: (c: string) => classes.has(c),
      toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); },
      remove: (c: string) => { classes.delete(c); },
    },
    addEventListener: (type: string, fn: () => Promise<void>) => { if (type === 'click') onClick = fn; },
    click: async () => { await onClick(); },
  };
  const fetched: string[] = [];
  const copied: string[] = [];
  const timers: Array<() => void> = [];
  let selected = '';
  const fetch = async (url: string) => { fetched.push(url); return (options.fetch ?? (async () => ({ ok: false })))(url); };
  const document = {
    querySelector: (sel: string) => (sel === '[data-npm-version]' ? line : sel === '[data-copy-status]' ? status : null),
    querySelectorAll: (sel: string) => (sel === '[data-copy-install]' ? [button] : []),
    createElement: () => {
      const area = { value: '', style: {}, setAttribute: () => {}, select: () => { selected = area.value; }, remove: () => {} };
      return area;
    },
    body: { appendChild: () => {} },
    execCommand: (command: string) => {
      const ok = (options.execCommand ?? (() => false))(command, selected);
      if (ok && command === 'copy') copied.push(selected);
      return ok;
    },
  };
  const writeText = options.writeText ?? (async (text: string) => { copied.push(text); });
  const context = {
    window: { fetch },
    fetch,
    document,
    navigator: { clipboard: { writeText } },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(appDir(), 'site', 'assets', 'install.js'), 'utf8'), context);
  return { line, status, button, fetched, copied, timers };
}

const answer = (version: string) => async () => ({ ok: true, json: async () => ({ name: 'ledung', version }) });

test("the version line asks npm for `latest` only and shows its first number, from the answer", async () => {
  const three = installBox({ fetch: answer('3.0.0') });
  await settle();
  // npm's `latest` manifest; never the `dev` tag (#436: "never shows a dev version").
  assert.deepEqual(three.fetched, ['https://registry.npmjs.org/ledung/latest']);
  // Martin on #436: "I dont want the two zeroes, only the first number."
  assert.equal(three.line.textContent, 'Ledung v3 on npm');
  // The number is the answer's, not a constant in the script.
  const seven = installBox({ fetch: answer('7.2.1') });
  await settle();
  assert.equal(seven.line.textContent, 'Ledung v7 on npm');
});

test("the version line keeps 'Ledung on npm' when npm has no plain release to show, and shows one beside it", async () => {
  // The positive branch, through the same probe: a plain release is shown.
  const plain = installBox({ fetch: answer('4.1.0') });
  const pre = installBox({ fetch: answer('4.0.0-beta.1') });
  const notOk = installBox({ fetch: async () => ({ ok: false, status: 503, json: async () => ({ version: '9.0.0' }) }) });
  const down = installBox({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  const empty = installBox({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await settle();
  assert.equal(plain.line.textContent, 'Ledung v4 on npm');
  assert.equal(pre.line.textContent, 'Ledung on npm', 'a pre-release on latest');
  assert.equal(notOk.line.textContent, 'Ledung on npm', 'npm answers with an error');
  assert.equal(down.line.textContent, 'Ledung on npm', 'npm cannot be reached');
  assert.equal(empty.line.textContent, 'Ledung on npm', 'an answer with no version');
});

test("Copy puts exactly `npm install -g ledung` on the clipboard and says so, then goes back to Copy", async () => {
  const box = installBox();
  await box.button.click();
  assert.deepEqual(box.copied, ['npm install -g ledung']);
  assert.equal(box.button.textContent, 'Copied');
  assert.ok(box.button.classList.has('done'));
  assert.equal(box.status.textContent, 'Copied npm install -g ledung');
  // The reset after a moment.
  box.timers.at(-1)!();
  assert.equal(box.button.textContent, 'Copy');
  assert.ok(!box.button.classList.has('done'));
  assert.equal(box.status.textContent, '');
});

test("without the Clipboard API the older copy command copies the same line, and when that is refused too the button says Copy failed", async () => {
  // No Clipboard API (plain http, an old browser): the textarea way copies the same text.
  const fallback = installBox({ writeText: async () => { throw new Error('NotAllowedError'); }, execCommand: () => true });
  await fallback.button.click();
  assert.deepEqual(fallback.copied, ['npm install -g ledung']);
  assert.equal(fallback.button.textContent, 'Copied');
  // Both refused: nothing copied, and the button and the screen-reader message say so.
  const refused = installBox({ writeText: async () => { throw new Error('NotAllowedError'); }, execCommand: () => false });
  await refused.button.click();
  assert.deepEqual(refused.copied, []);
  assert.equal(refused.button.textContent, 'Copy failed');
  assert.ok(!refused.button.classList.has('done'));
  assert.equal(refused.status.textContent, 'Copy failed');
});
