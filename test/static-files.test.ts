// The page's files: which are kept for good and how they are encoded (issue #229, audit O2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { compressible, isHashedAsset, pickEncoding } from '../src/server/static-files.ts';

test('Brotli when the browser takes it, else gzip, else the plain file', () => {
  assert.equal(pickEncoding('gzip, deflate, br, zstd'), 'br');
  assert.equal(pickEncoding('BR'), 'br', 'names are not case-sensitive');
  assert.equal(pickEncoding('gzip;q=0.8, deflate'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip', 'q=0 refuses it');
  assert.equal(pickEncoding('br; q=0.0, gzip;q=0'), null);
  assert.equal(pickEncoding(['deflate', 'gzip']), 'gzip');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(''), null);
  assert.equal(pickEncoding(undefined), null);
});

test('only files directly under assets/ count as hashed', () => {
  const root = path.resolve('/srv/web/dist');
  assert.equal(isHashedAsset(root, path.join(root, 'assets', 'index-DmMtaF7K.js')), true);
  assert.equal(isHashedAsset(root, path.join(root, 'index.html')), false);
  assert.equal(isHashedAsset(root, path.join(root, 'sw.js')), false);
  assert.equal(isHashedAsset(root, path.join(root, 'assets', 'deeper', 'x.js')), false);
  assert.equal(isHashedAsset(root, path.join(root, 'other', 'assets', 'x.js')), false);
});

test('text is compressed; pictures and fonts are not', () => {
  for (const f of ['a.js', 'a.css', 'index.html', 'icon.svg', 'manifest.webmanifest', 'x.json', 'A.JS']) assert.equal(compressible(f), true, f);
  for (const f of ['a.png', 'favicon.ico', 'f.woff2', 'noext']) assert.equal(compressible(f), false, f);
});
