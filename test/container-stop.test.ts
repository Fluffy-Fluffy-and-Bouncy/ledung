import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerStopScript } from '../src/host/stop.ts';

test('the container stop script goes by the session tag and avoids `kill --` (dash rejects it)', () => {
  const script = containerStopScript('ledung-abc');
  assert.match(script, /LEDUNG_TAG=ledung-abc/);
  assert.match(script, /\/tmp\/ledung-abc\.pid/);
  assert.doesNotMatch(script, /kill [^;]*--/);
  assert.doesNotMatch(script, /kill [^;]* -\$/);
});
