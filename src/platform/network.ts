// This computer's names on the local network, for when Ledung is opened to the LAN (config "lan": true).
import os from 'node:os';

/** This computer's IPv4 addresses on its networks (not the loopback ones). */
export function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);
}

/**
 * The names Ledung answers to on the network for the config's "lan" setting: one address (which must
 * belong to this computer) and the computer's name, or with `true` the name and all its addresses.
 */
export function lanNames(setting: boolean | string): string[] {
  if (setting === false) return [];
  const addresses = lanAddresses();
  if (setting === true) return [...new Set([os.hostname().toLowerCase(), ...addresses])];
  if (!addresses.includes(setting)) {
    throw new Error(`The config's "lan" address ${setting} is not one of this computer's addresses (${addresses.join(', ')}).`);
  }
  // Ledung listens only on that address, so the computer's name can only reach it through there too.
  return [setting, os.hostname().toLowerCase()];
}
