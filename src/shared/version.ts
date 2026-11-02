// How Ledung's version is shown (Martin, 2026-10-29, Ledung question #452): a public release is a plain number,
// v1, and a dev build after it is v1.1. npm needs three parts, so 1.0.0 is v1 and 1.1.0 is v1.1.

/** "1.0.0" → "v1", "1.1.0" → "v1.1"; anything else (a patch part, a pre-release) is shown whole, "v1.1.2". */
export function displayVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.0$/.exec(version);
  if (!m) return `v${version}`;
  return m[2] === '0' ? `v${m[1]}` : `v${m[1]}.${m[2]}`;
}

// The npm channels (issue #461; Martin, 2026-11-02 00:38, Ledung question #1172): a public release goes to npm's
// `latest`, a dev build to `dev`, so `npm install -g ledung` keeps getting the public one.

/** Which builds an npm-installed Ledung updates to: public releases only, or dev builds too. */
export type Channel = 'public' | 'dev';
export const CHANNELS: readonly Channel[] = ['public', 'dev'];

/** The npm dist-tag each channel publishes to and updates from. */
export const CHANNEL_TAG: Record<Channel, string> = { public: 'latest', dev: 'dev' };

/** [major, minor, patch] of a plain "X.Y.Z"; null for anything else, a pre-release included. */
export function parseVersion(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Below 0 when a is older than b, 0 when the same, above 0 when newer; versions that don't parse sort first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** A public release: a plain number, "2.0.0" (v2). */
export const isPublicVersion = (version: string): boolean => /^\d+\.0\.0$/.test(version);
/** A dev build after a public release: "2.1.0" (v2.1). */
export const isDevVersion = (version: string): boolean => /^\d+\.[1-9]\d*\.0$/.test(version);

/**
 * The version the next build of a channel gets, counted from the newest of `versions` (everything published, and
 * the clone's own): a dev build after v1 or v1.1 is v1.2, a public release after either is v2.
 */
export function nextVersion(channel: Channel, versions: string[]): string {
  const newest = versions.filter((v) => parseVersion(v)).sort(compareVersions).at(-1);
  if (!newest) throw new Error('There is no version to count from.');
  const [major, minor] = parseVersion(newest)!;
  return channel === 'dev' ? `${major}.${minor + 1}.0` : `${major + 1}.0.0`;
}

/**
 * The version a channel offers, from npm's dist-tags: Public offers `latest`; Dev offers `dev` or `latest`, whichever
 * is newer, so a public release made after the last dev build reaches Dev too without moving the `dev` tag.
 */
export function offeredVersion(channel: Channel, tags: Record<string, string | undefined>): string | null {
  const candidates = (channel === 'dev' ? [tags.dev, tags.latest] : [tags.latest]).filter((v): v is string => !!v && !!parseVersion(v));
  return candidates.sort(compareVersions).at(-1) ?? null;
}
