import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AUTOCORRECT_KEY, readAutocorrect, saveAutocorrect, typingProps, type TypingStore } from '../web/src/plainTyping.ts';

// Issue #147: autocorrect mangled what Martin typed in the page. It is off unless switched on in
// Settings; every free-text field spreads the props for it, and these tests read the page's source
// so a new field without them fails here.

function memoryStore(): TypingStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

test('autocorrect is off in a browser that never switched it on', () => {
  assert.equal(readAutocorrect(memoryStore()), false);
});

test('off: fields get autocorrect="off" and nothing else, so spell checking and capitals stay the browser\'s', () => {
  assert.deepEqual({ ...typingProps(false) }, { autoCorrect: 'off' });
});

test('on: fields get nothing, which leaves the browser\'s autocorrect', () => {
  assert.deepEqual({ ...typingProps(true) }, {});
});

test('the switch is kept in this browser and back off removes the entry', () => {
  const store = memoryStore();
  saveAutocorrect(store, true);
  assert.equal(readAutocorrect(store), true);
  saveAutocorrect(store, false);
  assert.equal(readAutocorrect(store), false);
  assert.equal(store.data.has(AUTOCORRECT_KEY), false);
});

test('a browser whose storage refuses is treated as off and saving does not throw', () => {
  const broken: TypingStore = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.equal(readAutocorrect(broken), false);
  assert.doesNotThrow(() => saveAutocorrect(broken, true));
});

const WEB_SRC = path.join(import.meta.dirname, '..', 'web', 'src');
// Inputs that aren't free text, plus password fields, which the issue leaves alone.
const NOT_FREE_TEXT = /\btype="(checkbox|radio|password|time|number|file|hidden|range|color)"/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : e.name.endsWith('.tsx') ? [p] : [];
  });
}

interface Field { file: string; line: number; kind: string; tag: string }

// Every <textarea> and <input> opening tag, up to its closing '>' outside {…}.
function fields(): Field[] {
  const found: Field[] = [];
  for (const file of sources(WEB_SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<(textarea|input)(?=[\s>/])/g)) {
      let depth = 0;
      let end = m.index + m[0].length;
      for (; end < src.length; end++) {
        const c = src[end];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) break;
      }
      found.push({ file: path.relative(WEB_SRC, file), line: src.slice(0, m.index).split('\n').length, kind: m[1] ?? '', tag: src.slice(m.index, end) });
    }
  }
  return found;
}

// The spread must be the hook's value: `const typing = usePlainTyping();` in the same file.
const spreads = (f: Field) => f.tag.includes('{...typing}');
const filesWithHook = new Set(sources(WEB_SRC).filter((f) => /const typing = usePlainTyping\(\);/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(WEB_SRC, f)));

test('every textarea in the page spreads the typing props', () => {
  const areas = fields().filter((f) => f.kind === 'textarea');
  // The composer, answers, notes, permission and project boxes: a scan that finds none is broken.
  assert.ok(areas.length >= 10, `found only ${areas.length} textareas`);
  assert.deepEqual(areas.filter((f) => !spreads(f) || !filesWithHook.has(f.file)).map((f) => `${f.file}:${f.line}`), []);
});

test('every free-text input in the page spreads the typing props, and no password field does', () => {
  const inputs = fields().filter((f) => f.kind === 'input');
  const text = inputs.filter((f) => !NOT_FREE_TEXT.test(f.tag));
  assert.ok(text.length >= 10, `found only ${text.length} text inputs`);
  assert.deepEqual(text.filter((f) => !spreads(f) || !filesWithHook.has(f.file)).map((f) => `${f.file}:${f.line}`), []);
  const passwords = inputs.filter((f) => /\btype="password"/.test(f.tag));
  assert.ok(passwords.length >= 1, 'the account token field should still be found');
  assert.deepEqual(passwords.filter(spreads).map((f) => `${f.file}:${f.line}`), []);
});
