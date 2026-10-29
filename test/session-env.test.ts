// Sessions never inherit Ledung's own settings (CLAUDE.md, "Rules that exist for a reason").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionEnv } from '../src/runners/runner.ts';

test('sessions inherit no LEDUNG_* settings', () => {
  const env = sessionEnv({ env: { LEDUNG_CONFIG: 'a', LEDUNG_DATA_DIR: 'b', PATH: 'p' } } as never);
  assert.deepEqual(env, { PATH: 'p' });
});
