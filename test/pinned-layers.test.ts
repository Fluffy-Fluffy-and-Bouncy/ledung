import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Issue #226: the session header's ⚙ menu must be drawn over the pinned latest message, and the pinned strip ends
// in a short fade instead of a line. Read from the stylesheet, as the phone layout tests do.
const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every declaration of the rules whose selector list has exactly this selector, wherever they are (media included). */
function declarations(selector: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1]!.split(',').some((s) => s.trim() === selector)) continue;
    for (const d of m[2]!.split(';')) {
      const at = d.indexOf(':');
      if (at < 0) continue;
      const name = d.slice(0, at).trim();
      found.set(name, [...(found.get(name) ?? []), d.slice(at + 1).trim()]);
    }
  }
  return found;
}

function zIndex(selector: string): number {
  const values = declarations(selector).get('z-index') ?? [];
  assert.equal(values.length, 1, `${selector} has one z-index (found ${JSON.stringify(values)})`);
  return Number(values[0]);
}

test('the session header is one layer above the chat, so its menu is drawn over the pinned message and the composer', () => {
  const head = declarations('.session-head');
  // A z-index only works on a positioned box; without both, the header's own layer (its container query can make
  // one) sits under the pinned message, whatever the menu's z-index inside it.
  assert.ok((head.get('position') ?? []).includes('relative'), '.session-head is positioned');
  const z = zIndex('.session-head');
  assert.ok(z > zIndex('.pin-spot'), 'above the pinned message');
  assert.ok(z > zIndex('.composer-grip'), 'above the composer grip');
});

test('what opens over the page stays above the session header (and so above the pinned message)', () => {
  const z = zIndex('.session-head');
  assert.ok(zIndex('.macro-menu') > z, 'macro menu');
  assert.ok(zIndex('.row-menu') > z, 'row menu');
  assert.ok(zIndex('.file-panel') > z, 'file panel on a phone');
  assert.ok(zIndex('.pin-spot') < zIndex('.macro-menu') && zIndex('.pin-spot') < zIndex('.file-panel'), 'the pinned message stays under them');
});

test('the pinned strip ends in a short fade, not a line or a shadow, and stays opaque where its text is', () => {
  // The probe finds a bottom border where there is one (the session header has one), so its absence below is real.
  assert.ok(declarations('.session-head').has('border-bottom'));
  const strip = declarations('.pinned-strip');
  assert.deepEqual(strip.get('background'), ['var(--bg)']);
  assert.equal(strip.has('border-bottom'), false);
  assert.equal(strip.has('box-shadow'), false);
  const fade = declarations('.pinned-strip::after');
  assert.deepEqual(fade.get('top'), ['100%'], 'the fade hangs below the strip, not over its text');
  assert.deepEqual(fade.get('background'), ['linear-gradient(var(--bg), transparent)'], 'from the strip\'s colour to nothing');
  assert.deepEqual(fade.get('pointer-events'), ['none'], 'clicks go through to the message under it');
});
