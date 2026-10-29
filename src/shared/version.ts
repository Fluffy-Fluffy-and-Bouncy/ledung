// How Ledung's version is shown (Martin, 2026-10-29, Ledung question #452): a public release is a plain number,
// v1, and a dev build after it is v1.1. npm needs three parts, so 1.0.0 is v1 and 1.1.0 is v1.1.

/** "1.0.0" → "v1", "1.1.0" → "v1.1"; anything else (a patch part, a pre-release) is shown whole, "v1.1.2". */
export function displayVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.0$/.exec(version);
  if (!m) return `v${version}`;
  return m[2] === '0' ? `v${m[1]}` : `v${m[1]}.${m[2]}`;
}
