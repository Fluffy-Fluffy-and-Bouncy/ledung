// Runs the tests (`npm test`) with a data folder and config of their own (issue #435).
//
//   node scripts/test.ts [test files]    default: every test/**/*.test.ts
//
// Settings → Update Ledung runs the release, and so the tests, with LEDUNG_DATA_DIR and LEDUNG_CONFIG set to the
// running Ledung's real ones; a shell can have them set too. A test that falls back to the defaults would then read
// or write that Ledung's data. Here every LEDUNG_* setting the tests inherit is dropped, and the data folder and
// config point into a temp folder made for this run, so even a test that forgets its own lands there and not in the
// platform's data folder or the clone's config. A test that needs them unset unsets them itself.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const files = process.argv.slice(2);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ledung-tests-'));
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && !k.startsWith('LEDUNG_')) env[k] = v;
}
env.LEDUNG_DATA_DIR = path.join(base, 'data');
env.LEDUNG_CONFIG = path.join(base, 'config.json');

const child = spawn(process.execPath, ['--test', ...(files.length ? files : ['test/**/*.test.ts'])], { env, stdio: 'inherit' });
// Ctrl+C reaches the test run too; this exits when it does.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {});
const code = await new Promise<number>((resolve) => {
  child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  child.on('error', (e) => { console.error(e.message); resolve(1); });
});
try {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });
} catch {
  // A file Windows still holds; the temp folder is the system's to clear.
}
process.exit(code);
