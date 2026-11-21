// The product is called "Ledung" wherever a person sees it (#428): the #407 play check found the tab, the desktop
// app's window and its taskbar entry saying "Project Ledung", since the window takes the page's title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pageTitle, PRODUCT_NAME } from '../web/src/pageTitle.ts';

const root = path.join(import.meta.dirname, '..');

test('the page title reads "Ledung", or "(N) Ledung" with N waiting (#428)', () => {
  assert.equal(PRODUCT_NAME, 'Ledung');
  assert.equal(pageTitle(0), 'Ledung');
  assert.equal(pageTitle(3), '(3) Ledung');
});

test('the page as first served, and the installed app, are named "Ledung" (#428)', () => {
  assert.match(readFileSync(path.join(root, 'web/index.html'), 'utf8'), /<title>Ledung<\/title>/);
  const manifest = JSON.parse(readFileSync(path.join(root, 'web/public/manifest.webmanifest'), 'utf8')) as { name: string; short_name: string };
  assert.equal(manifest.name, 'Ledung');
  assert.equal(manifest.short_name, 'Ledung');
});

// What a person sees comes from the page and the desktop app; the repository and docs keep the project's name (#428, Out of scope).
const OLD_NAME = /Project Ledung/;
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : filesUnder(full);
    return /\.(tsx?|[cm]?js|html|css|json|webmanifest)$/.test(name) ? [full] : [];
  });
}
function namedOldWay(files: string[]): string[] {
  return files.filter((f) => OLD_NAME.test(readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
}

test('nothing in the page or the desktop app still says "Project Ledung" (#428)', () => {
  const files = [
    ...filesUnder(path.join(root, 'web/src')),
    ...filesUnder(path.join(root, 'web/public')),
    path.join(root, 'web/index.html'),
    ...filesUnder(path.join(root, 'desktop')),
  ];
  assert.ok(files.length > 10, `the scan reached the page and the desktop app (${files.length} files)`);
  // The probe finds the old name where it is: a test fixture serves a page titled the old way.
  assert.deepEqual(namedOldWay([path.join(root, 'test/desktop.test.ts')]), [path.join('test', 'desktop.test.ts')]);
  assert.deepEqual(namedOldWay(files), []);
});
