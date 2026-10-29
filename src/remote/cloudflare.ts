// Writing a new computer's CAA record through Cloudflare's API (issue #237, Approve): with a zone token kept on the
// relay admin's own computer, never on the relay server (Martin, question #400: "b — Approve button with a zone
// token on your PC"; research report section 2, option a: a token on the server undoes the lock).
//
// It only ever adds: a name that has any CAA record already is refused, never changed, so Approve can't hand an
// existing computer's name to another ACME account. Changing one stays a person's job in Cloudflare itself.
const API = 'https://api.cloudflare.com/client/v4';

export interface CaaIssue {
  /** The DNS name the record is for, e.g. "copper7meadow4.l.example.org" (no trailing dot). */
  name: string;
  /** The record's value: `letsencrypt.org; accounturi=…; validationmethods=tls-alpn-01`. */
  value: string;
}

interface Envelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result: T;
}

export class Cloudflare {
  private readonly token: string;
  private readonly fetch: typeof fetch;

  constructor(token: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.fetch = fetcher;
  }

  /** Adds the CAA issue record for the name in the zone that holds it. Refuses when the name has any CAA record. */
  async addCaa(record: CaaIssue): Promise<void> {
    const zone = await this.zoneOf(record.name);
    const existing = await this.call<{ id: string }[]>('GET', `/zones/${zone}/dns_records?type=CAA&name=${encodeURIComponent(record.name)}`);
    if (existing.length) {
      throw new Error(`${record.name} already has a CAA record in Cloudflare; Ledung never changes one. Look at it in Cloudflare's dashboard.`);
    }
    await this.call('POST', `/zones/${zone}/dns_records`, {
      type: 'CAA', name: record.name, ttl: 1, data: { flags: 0, tag: 'issue', value: record.value },
    });
  }

  /** The zone holding a name: the longest of its parent names Cloudflare has a zone for, found with this token. */
  private async zoneOf(name: string): Promise<string> {
    const labels = name.split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join('.');
      const zones = await this.call<{ id: string; name: string }[]>('GET', `/zones?name=${encodeURIComponent(candidate)}`);
      const zone = zones.find((z) => z.name === candidate);
      if (zone) return zone.id;
    }
    throw new Error(`The Cloudflare token reaches no zone holding ${name}.`);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`Cloudflare could not be reached: ${(e as Error).message}`);
    }
    const answer = await res.json().catch(() => null) as Envelope<T> | null;
    if (!res.ok || !answer?.success) {
      const why = answer?.errors?.map((e) => e.message).filter(Boolean).join('; ');
      throw new Error(`Cloudflare refused (${res.status})${why ? `: ${why}` : ''}.`);
    }
    return answer.result;
  }
}
