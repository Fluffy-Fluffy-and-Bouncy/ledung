import net from 'node:net';

// The Fetch standard's "bad port" list (also undici's): fetch refuses these with "bad port".
// With a low TCP dynamic port range (issue #321: 1024-14999) listen(0) can hand one out.
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export const isBadFetchPort = (port: number): boolean => BAD_PORTS.has(port);

const osPort = () => new Promise<number>((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as net.AddressInfo;
    probe.close(() => resolve(port));
  });
});

/** A port nothing listens on right now and that fetch will connect to; `source` is for the test of this helper. */
export async function freePort(source: () => Promise<number> = osPort): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const port = await source();
    if (!isBadFetchPort(port)) return port;
  }
  throw new Error('no port outside fetch\'s blocked list after 100 tries');
}

/** Listens on a port the OS picks (host default 127.0.0.1) and tries again while fetch would refuse it. */
export async function listenOk(server: net.Server, host = '127.0.0.1'): Promise<number> {
  for (let i = 0; i < 100; i++) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, () => { server.off('error', reject); resolve(); });
    });
    const { port } = server.address() as net.AddressInfo;
    if (!isBadFetchPort(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error('no port outside fetch\'s blocked list after 100 tries');
}
