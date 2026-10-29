// AGPL section 13 (issue #332): everyone who uses Ledung over a network must be offered its source. The page's
// Settings → About shows the running version and a Source link to it; this works out both.
import fs from 'node:fs';
import path from 'node:path';
import type { SourceOffer } from '../shared/protocol.ts';
import type { ReleaseInfo } from '../update/updater.ts';
import { displayVersion } from '../shared/version.ts';

/** Logged on the first start; Settings → About and the README say the same. */
export const ANTHROPIC_NOTICE = "Ledung runs Anthropic's Claude Agent SDK and Claude Code, installed from npm under Anthropic's own terms (https://code.claude.com/docs/en/legal-and-compliance). They are not covered by Ledung's license (AGPL-3.0-only, see LICENSE).";

/** Where the source is when package.json doesn't say. A fork names its own repository in package.json. */
export const DEFAULT_REPOSITORY = 'https://github.com/Fluffy-Fluffy-and-Bouncy/ledung';

/** The web address of a package.json `repository` ("git+https://…/x.git" → "https://…/x"); null without one. */
export function repositoryUrl(pkg: unknown): string | null {
  const repo = (pkg as { repository?: unknown } | null)?.repository;
  const raw = typeof repo === 'string' ? repo : typeof (repo as { url?: unknown } | undefined)?.url === 'string' ? (repo as { url: string }).url : null;
  if (!raw) return null;
  const url = raw.replace(/^git\+/, '').replace(/\.git$/, '');
  return /^https:\/\//.test(url) ? url : null;
}

/**
 * The version to show and the source it came from. A release names its commit, so the link goes to that commit;
 * the npm package and a source folder link to the repository, with the version or the folder's name.
 */
export function sourceOffer(o: { repository: string; packaged: boolean; version: string; release: ReleaseInfo | null; build: string }): SourceOffer {
  const version = displayVersion(o.version);
  if (o.packaged) return { version: `ledung ${version}`, url: o.repository };
  if (o.release?.commit) return { version: `${version}, commit ${o.release.commit.slice(0, 7)}`, url: `${o.repository}/tree/${o.release.commit}` };
  return { version: `${version}, ${o.build}`, url: o.repository };
}

/** The repository named in the package.json Ledung runs from, else the default. */
export function readRepository(appDir: string): string {
  try {
    return repositoryUrl(JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))) ?? DEFAULT_REPOSITORY;
  } catch {
    return DEFAULT_REPOSITORY;
  }
}
