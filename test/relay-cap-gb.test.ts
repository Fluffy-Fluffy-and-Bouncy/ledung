// The cap field in Settings → Relay → Owners (issue #161) shows and takes GB, the relay keeps bytes: 1 GB = 1024³ bytes
// (the merge brief's call). Expected figures are worked out by hand from that, not taken from a run (test review of
// PR #173: a GB→bytes slip in the field got through every other test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capFromGb, capGbText } from '../web/src/relayCapGb.ts';

test('ledung#161: a GB figure typed in the cap field becomes bytes at 1024³ a GB', () => {
  assert.equal(capFromGb('1'), 1_073_741_824);
  assert.equal(capFromGb('2'), 2_147_483_648);
  assert.equal(capFromGb('0.5'), 536_870_912);
  assert.equal(capFromGb(' 10 '), 10_737_418_240);
  assert.equal(capFromGb('1000000'), 1_073_741_824_000_000, 'a petabyte-sized cap, the relay\'s ceiling is 10¹⁵');
  // 0.001 GB = 1 073 741.824 bytes, rounded to whole bytes.
  assert.equal(capFromGb('0.001'), 1_073_742);
});

test('ledung#161: what is not a number above 0 sets no cap, and a number does', () => {
  for (const text of ['', '   ', '0', '-1', 'abc', '1e400', 'NaN']) assert.equal(capFromGb(text), null, JSON.stringify(text));
  assert.equal(capFromGb('3'), 3 * 1_073_741_824, 'the positive branch');
});

test('ledung#161: a cap is prefilled in GB, whole from 100 up and to three figures below, so a small cap is not 0', () => {
  assert.equal(capGbText(null), '', 'no cap: an empty field');
  assert.equal(capGbText(1_073_741_824), '1');
  assert.equal(capGbText(536_870_912), '0.5');
  assert.equal(capGbText(1_610_612_736), '1.5');
  assert.equal(capGbText(161_061_273_600), '150', '150 GB');
  assert.equal(capGbText(161_598_144_512), '151', '150.5 GB rounds to whole GB from 100 up');
  // The loopback's cap, 908 000 bytes = 0.000845636… GB: three figures, never 0 (the stale shot showed 0).
  assert.equal(capGbText(908_000), '0.000846');
  assert.equal(capGbText(1_234_567_890), '1.15', '1.1497809… GB');
});

test('ledung#161: a cap read back into the field and set again is the same cap', () => {
  for (const gb of ['1', '0.5', '2.25', '150']) assert.equal(capGbText(capFromGb(gb)), gb);
});
