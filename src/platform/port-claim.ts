// The port, claimed before Ledung touches anything (#503). A start that finds it busy has done nothing yet: it has not
// reattached a session host (a host hands itself to the newest Ledung that connects, so a start that loses the port
// would take the sessions from the Ledung that has it), nor written to the database. On a restart the Ledung before it
// may still be letting go of the port, so the start waits for it instead of failing at once.
import net from 'node:net';

/** How long a restart waits for the port before it gives up: the Ledung before it closes in well under that. */
export const RESTART_PORT_WAIT_MS = 30_000;
const RETRY_MS = 500;

/** The addresses Ledung listens on: 0.0.0.0 already includes 127.0.0.1; a single network address needs a second listener. */
export function listenAddresses(lanBind: string | undefined): string[] {
  return lanBind === '0.0.0.0' ? ['0.0.0.0'] : lanBind ? ['127.0.0.1', lanBind] : ['127.0.0.1'];
}

/** The port, held on every address until release(), which the server's own listen follows at once. */
export interface PortClaim {
  release(): Promise<void>;
}

export interface ClaimOptions {
  port: number;
  addresses: string[];
  /** How long to keep trying while the port is in use; 0 tries once. */
  waitMs: number;
  retryMs?: number;
  /** Said once, when the first try finds the port busy and there is time to wait. */
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function listenOn(port: number, address: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    // Nothing is served while it is held: a connection (another start asking whether Ledung runs) is closed at once.
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen({ port, host: address, exclusive: true }, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** One try on every address: the claim, or null when one of them is in use (any other error is thrown). */
async function tryClaim(port: number, addresses: string[]): Promise<net.Server[] | null> {
  const held: net.Server[] = [];
  try {
    for (const address of addresses) held.push(await listenOn(port, address));
    return held;
  } catch (e) {
    await Promise.all(held.map(close));
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') return null;
    throw e;
  }
}

/** Claims the port, waiting up to waitMs while it is in use; null when it is still in use then. */
export async function claimPort(opts: ClaimOptions): Promise<PortClaim | null> {
  const deadline = Date.now() + opts.waitMs;
  let said = false;
  for (;;) {
    const held = await tryClaim(opts.port, opts.addresses);
    if (held) return { release: async () => { await Promise.all(held.map(close)); } };
    if (Date.now() >= deadline) return null;
    if (!said) {
      opts.log?.(`Port ${opts.port} is in use; waiting up to ${Math.round(opts.waitMs / 1000)} s for it to be freed...`);
      said = true;
    }
    await sleep(Math.min(opts.retryMs ?? RETRY_MS, Math.max(0, deadline - Date.now())));
  }
}
