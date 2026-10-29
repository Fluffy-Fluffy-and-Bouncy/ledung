// Settings' Remote line (issue #160): the tunnel to the relay, in words.
import type { CertificateStatus, RemoteStatus } from '../../src/shared/protocol.ts';

export function remoteLine(remote: RemoteStatus | null): { label: string; detail: string | null } {
  if (!remote) return { label: 'Remote: off', detail: 'Not on a relay: join one with a code below, or set "remote" in the config.' };
  switch (remote.state) {
    case 'connected':
      return { label: 'Remote: connected', detail: `Through the relay as ${remote.publicName}.` };
    case 'connecting':
      return { label: 'Remote: connecting…', detail: `To the relay, as ${remote.publicName}.` };
    case 'reconnecting':
      return { label: 'Remote: reconnecting', detail: remote.error };
  }
}

/** Fewer days than this left on the certificate: Settings warns (docs/steps/relay-e2e.md 3b). */
const WARN_DAYS = 7;
const DAY = 86_400_000;

/**
 * Settings' certificate line (issue #202): where Ledung's own certificate for the public name stands, in words.
 * `copy`: show the account URL and the CAA record to add, with Check now.
 */
export function certificateLine(cert: CertificateStatus, now: number): { label: string; detail: string | null; warn: boolean; copy: boolean } {
  const until = cert.validUntil ? new Date(cert.validUntil).toLocaleString() : null;
  const next = cert.nextTry ? new Date(cert.nextTry).toLocaleTimeString() : null;
  const ending = cert.validUntil !== null && cert.validUntil - now < WARN_DAYS * DAY;
  const inUse = until ? ` The one in use is valid until ${until}.` : '';
  switch (cert.state) {
    case 'valid':
      return { label: `Certificate valid until ${until}`, detail: ending ? `Fewer than ${WARN_DAYS} days left: it renews while Ledung is connected to the relay.` : null, warn: ending, copy: false };
    case 'offline':
      return { label: 'Certificate: none yet', detail: 'Ledung orders one once it is connected to the relay.', warn: true, copy: false };
    case 'waiting-caa':
      return {
        label: 'Waiting for the CAA record',
        detail: `Add this record to the DNS for the name. Ledung looks it up every minute${next ? ` (next at ${next})` : ''} and orders as soon as it names this account.${cert.error ? ` ${cert.error}` : ''}${inUse}`,
        warn: !until || ending, copy: true,
      };
    case 'ordering':
      return { label: until ? 'Renewing the certificate…' : 'Getting a certificate…', detail: inUse.trim() || null, warn: false, copy: false };
    case 'failed':
      return {
        label: until ? 'Renewal failed' : 'Getting a certificate failed',
        detail: `${cert.error ?? ''}${next ? ` Trying again at ${next}.` : ''}${inUse}`.trim() || null,
        warn: true, copy: false,
      };
  }
}
