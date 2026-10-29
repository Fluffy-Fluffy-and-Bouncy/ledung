// A project's remote address, the identity its anonymous usage label is made from (issue #363): `origin` of the
// project folder's repository, read with git and kept for an hour. Only for projects on this computer; a container
// project, a folder without one and a removed project are labelled from their Ledung name instead.
import { execFile } from 'node:child_process';

const KEEP_MS = 60 * 60 * 1000;

export class ProjectRemotes {
  private readonly kept = new Map<string, { url: string | null; at: number }>();
  private readonly folderOf: (project: string) => string | null;
  private readonly read: (folder: string) => Promise<string | null>;

  constructor(folderOf: (project: string) => string | null, read: (folder: string) => Promise<string | null> = originOf) {
    this.folderOf = folderOf;
    this.read = read;
  }

  async remotes(projects: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const p of projects) {
      const folder = this.folderOf(p);
      if (!folder) {
        out.set(p, null);
        continue;
      }
      let k = this.kept.get(folder);
      if (!k || Date.now() - k.at > KEEP_MS) {
        k = { url: await this.read(folder), at: Date.now() };
        this.kept.set(folder, k);
      }
      out.set(p, k.url);
    }
    return out;
  }
}

function originOf(folder: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', folder, 'remote', 'get-url', 'origin'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      const url = String(stdout ?? '').trim();
      resolve(err || !url ? null : url);
    });
  });
}
