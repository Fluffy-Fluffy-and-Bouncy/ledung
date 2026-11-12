// Ledung's config writer (docs/steps/ledung-helper.md, "Every setting"): one top-level setting of the config file
// changed, everything else as the file has it ($comments and keys this version doesn't know included), checked with
// the same schema as at start before anything is written, and written atomically so the watcher (config-watch.ts)
// never reads half a file. Until now no API wrote the config; this is the one place that does.
import fs from 'node:fs';
import path from 'node:path';
import { parseConfig, SETTING_RELOAD, type LedungConfig, type SettingName } from './config.ts';

export class ConfigWriteError extends Error {}

/** The file's own JSON object; a file that isn't one is refused, never overwritten. */
function readRaw(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigWriteError(`The config file can't be read (${(e as NodeJS.ErrnoException).code ?? 'error'}).`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigWriteError('The config file is not valid JSON, so Ledung leaves it alone; fix it first (Settings → Config file).');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigWriteError('The config file is not a JSON object.');
  return raw as Record<string, unknown>;
}

/** The file's own object and the config it makes, as saved now (a restart-only change may not run yet). */
export function savedConfig(file: string): { raw: Record<string, unknown>; config: LedungConfig } {
  const raw = readRaw(file);
  try {
    return { raw, config: parseConfig(raw) };
  } catch (e) {
    throw new ConfigWriteError(`The config file has a problem, so Ledung leaves it alone; fix it first (Settings → Config file): ${(e as Error).message.split('\n')[0]}`);
  }
}

/** The config as it would be with this setting (undefined: left out, back to its default); throws why not. */
export function configWith(file: string, key: SettingName, value: unknown): { raw: Record<string, unknown>; config: LedungConfig } {
  if (!(key in SETTING_RELOAD) || key === '$comment') throw new ConfigWriteError(`"${key}" is not a setting of the config file.`);
  const raw = { ...readRaw(file) };
  if (value === undefined) delete raw[key];
  else raw[key] = value;
  let config: LedungConfig;
  try {
    config = parseConfig(raw);
  } catch (e) {
    throw new ConfigWriteError(`That value can't be used: ${(e as Error).message.split('\n').map((l) => l.trim()).filter(Boolean).join('; ')}`);
  }
  return { raw, config };
}

/** Writes it: to a temporary file next to the config, then renamed over it, keeping the file's indentation. */
export function writeConfig(file: string, raw: Record<string, unknown>): void {
  const old = fs.readFileSync(file, 'utf8');
  const indent = /^\{\s*\n(\s+)"/.exec(old)?.[1] ?? '  ';
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(raw, null, indent)}\n`, { flag: 'w' });
  try {
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw new ConfigWriteError(`The config file could not be written: ${(e as Error).message}`);
  }
}
