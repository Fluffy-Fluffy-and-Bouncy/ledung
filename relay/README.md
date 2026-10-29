# Ledung relay

Lets a phone reach a running Ledung from anywhere (issue #160, `docs/steps/relay.md`). Each Ledung
dials out to the relay over one WebSocket; a phone opens the Ledung's public name, the server's
reverse proxy hands that to the relay, and the relay passes the bytes through that Ledung's
connection to it. The computer running Ledung needs no open port, no firewall rule and no admin
rights.

The relay decides nothing about who may use a Ledung. Ledung counts every request that comes
through the relay as one on its public name, whatever Host it carries, so only its paired devices
get in (Ledung's own checks: device cookie, Origin, passkey). The relay reads only the request
head, to find the Host, and stores only its config and the computers added to it. It logs connects, disconnects and refusals,
never what goes through.

It is not part of Ledung's release copy or npm package; it runs on its own, in its own container.

## Set up

1. **A secret per Ledung.** Make a long random one, for example
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`, and hash it:
   `echo <secret> | node relay.ts hash`. The secret goes in that Ledung's config; only the hash goes
   in the relay's.
   `node src/main.ts remote-secret` in a Ledung folder does both (Adding a computer, below).
2. **The relay's config.** Copy `relay.config.example.json` to `relay.config.json` (not committed).
   One entry under `agents` per Ledung: `name` (what the Ledung gives), `owner` (who it belongs to),
   `host` (the public name phones use) and `secretSha256`. Names and hosts are only ever in this
   file. With a reverse proxy in front, `"trustProxy": true` takes the caller's address from the
   last `X-Forwarded-For` entry, for the limit on failed sign-ins.
3. **Run it.** From the repository's root:
   `docker build -f relay/Dockerfile -t ledung-relay .`, then
   `docker run -d --name ledung-relay --restart unless-stopped -p 127.0.0.1:8080:8080 -v <path>/relay.config.json:/config/relay.config.json:ro -v ledung-relay-data:/data ledung-relay`.
   The `/data` volume keeps the computers added with `add` (below); without it they are lost when
   the container is made anew.
   Without Docker: `npm ci` in `relay/`, then `node relay.ts relay.config.json` (Node 24).
   With `passthroughPort` set (below), the proxy reaches that port over the containers' own
   network; it is not published.
4. **The reverse proxy.** Point the relay's own name (the one Ledungs dial) and each Ledung's public
   name at the relay's port, with HTTPS and WebSocket upgrades passed through and the Host header
   kept. `https://<relay name>/health` answers `ok`.
5. **Each Ledung's config** gets
   `"remote": { "relay": "wss://<relay name>", "name": "<name>", "publicName": "<host>", "secret": "<secret>" }`;
   Settings then shows Remote: connected.

## Adding a computer

`node relay.ts add`, `remove` and `list` change the computers on the **running** relay: no restart,
and the Ledungs already connected stay connected. Only a hash ever reaches the relay's admin: the
new computer's Ledung makes its own secret and keeps it. Every computer added this way is reached
end to end (`"tls": "passthrough"`, below), so its owner's traffic can't be read on the server.

Once, in the relay's config: `passthroughPort` (End to end, below), `"domain"`, the domain added
computers are named under (`<name>.l.<domain>`; the server's proxy and DNS route `*.l.<domain>` to
the relay), and `"relayUrl"`, the address Ledungs dial (`wss://relay.<domain>`), which `add` puts in
the block it prints.

Then, per computer:

1. **Its owner makes a secret.** On that computer, in the Ledung folder:
   `node src/main.ts remote-secret` (with the npm package: `ledung remote-secret`). It prints a new
   secret, which goes in their config and stays with them, and its SHA-256, which they send to you.
   It reads no config and changes nothing.
2. **You add it**, where the relay runs:
   `docker exec ledung-relay node relay.ts add --hash <the hash> --owner <who>`.
   It picks a word name such as `copper7meadow4` that isn't taken; `--name <name>` takes yours
   instead, and `--host <host>` a host of the owner's own domain instead of `<name>.l.<domain>`.
   The computer can connect at once.
3. **It prints the `"remote"` block** for the owner's `ledung.config.local.json`: the relay, the
   name, the public name, `"tls": "required"` and `"acme": "production"`, and a placeholder where
   their secret goes. Send them the block.
4. **They paste it**, put their secret in, and restart Ledung. Settings then shows Remote:
   connected, and a CAA line for its public name; they send you that line.
5. **You add the CAA record** in the DNS. Their Ledung finds it within a minute, gets its own
   certificate, and they pair their phone in Settings → Devices.

`node relay.ts list` shows every computer: its owner, host, whether it comes from the config or was
added, and whether it is connected. `node relay.ts remove <name>` removes an added computer and
disconnects it at once; one written in the config is removed there, with a restart. A new secret
for a computer is `remove`, then `add` with the new hash.

- **The commands reach the relay only from where it runs.** They talk to it over a local socket
  (`ledung-relay-admin.sock` in the temporary folder, `/tmp` in the container; a named pipe on
  Windows; `RELAY_ADMIN_SOCKET` moves it), never
  over its ports, so nobody reaches them from the internet. On Linux and macOS only the relay's own
  user may use the socket.
- **What is added is kept** in `relay.added.json` beside the config (in the container,
  `/data/relay.added.json`; `RELAY_STORE` moves it), written whole and then swapped in, so the file
  is never half written. It holds names, owners, hosts and hashes, never a secret. Change it with
  `add` and `remove`, not by hand. If one of its computers clashes with an entry since written in
  the config, the config's wins, and the relay logs `added agent skipped` at start. So does one
  that is not `"tls": "passthrough"`: what is added is always end to end.
- Entries written in the config by hand work as before, `"tls": "proxy"` included; `add` refuses
  `--tls proxy`.

## Invite a computer

The same, from the admin's own Ledung instead of a shell on the server (issue #237): the admin
presses **Invite a computer**, the other person pastes a join code into their Ledung, and the admin
approves the CAA record with one tap. Nobody edits a config file, and no Ledung restarts.

Once:

1. **In your Ledung**, Settings → Relay → Set up as a relay admin: the relay's address
   (`wss://relay.<domain>`) and **Make admin key**. Ledung keeps the key in its data folder
   (`relay-admin.json`, private to you) and shows only its SHA-256.
2. **In the relay's config**, `"adminKeySha256": "<that hash>"`, with `"domain"`, `"relayUrl"` and
   `passthroughPort` as for `add`; restart the relay once. Without `adminKeySha256` the admin API and
   enrolment are off.
3. **Optional, for Approve:** a Cloudflare API token that can edit DNS in the zone of `<domain>`
   (Zone → DNS → Edit, that zone only), pasted into Settings → Relay. It stays on your computer: it
   is never sent to the page, and **never goes on the relay's server**, where it would let the server
   give itself a certificate for anyone's name (Martin, 2026-10-20, question #400). Without it you
   copy each record into the DNS by hand.

Per computer:

1. **You invite:** Settings → Relay → Invite a computer, with the owner's name and, if you like, a
   name (otherwise a word name such as `copper7meadow4`; a host of their own domain is possible
   through the API). The relay reserves the name and your Ledung shows the **join code** once:
   `relay.<domain>/XXXX-XXXX-…`, valid for 24 hours and for one use. Send it to them.
2. **They join:** Settings → Remote → Join with a code. Their Ledung makes its own secret and its
   ACME account, sends the relay only the secret's SHA-256 and the account's URL, saves its remote
   settings in its data folder with `"tls": "required"`, and connects at once.
3. **You approve:** your Waiting for you shows **New computer `<name>` for `<owner>`** with the
   exact CAA record. **Approve** writes it through Cloudflare and refuses a name that has a CAA
   record already (changing one stays yours, in Cloudflare); without a token, **Copy** it into the
   DNS and press **I added it**. Their Ledung finds the record within a minute, gets its
   certificate, and they pair their phone in Settings → Devices.

How the relay does it:

- **The admin API** is on the relay's own HTTP port, so it is reached as `https://relay.<domain>/admin/…`
  through the proxy: `POST /admin/invites` (`{ owner, name?, host? }`; the answer carries the token,
  once), `GET /admin/invites`, `DELETE /admin/invites/<id>`, `GET /admin/computers` (the computers
  that joined, with their ACME account URL) and `POST /admin/computers/<name>/approved`. Every
  call needs `Authorization: Bearer <admin key>`.
- **Enrolment** is `POST /enrol` with `{ code, secretSha256, accountUrl }`. The code is used up, the
  computer is added as `add` adds one (end to end, kept in `relay.added.json`) under the reserved
  name, and the answer is its name and host. A used, revoked, run-out or made-up code gets one and
  the same refusal.
- **Abuse limits:** a wrong admin key or a bad code counts as a failed attempt from that address,
  like a wrong agent secret, and `limits.failedAttemptsPerAddress` of them turn the address away
  for `limits.attemptWindowSeconds`. Bodies are at most 4 KB, and at most 100 invites are open at
  once. Neither the key, a token nor a secret is logged.
- **What is kept:** `relay.invites.json` beside the store (`RELAY_INVITES` moves it), written the
  same way: open invites with only their token's SHA-256, and the computers that joined, with their
  ACME account URL and whether their record was written. `remove` on a joined computer drops it
  there too.
- **Leave this relay**, on their side, only stops their Ledung using it; you take the name off the
  relay with `remove`.

## End to end: passing TLS through

With the steps above, TLS ends at the server's reverse proxy, which can read everything. An agent
with `"tls": "passthrough"` is reached end to end instead (`docs/steps/relay-e2e.md`): the proxy
routes its name, still encrypted, to the relay's **passthrough listener**, and the relay passes
every byte to the Ledung, which ends TLS itself with a certificate only it holds. The relay holds
no certificate and no key, and cannot end TLS for that name.

- **`passthroughPort`** in the relay's config (8443 in the plan) switches the listener on. It
  takes raw TLS from the proxy, preceded by a PROXY protocol v2 header with the phone's address
  (caddy-l4's `proxy_protocol v2`). A connection without that header is closed, so keep the port
  on the internal network only: never publish it (`-p`), only the proxy may reach it.
- **`passthroughFrom`** lists who may connect to that port, and so speak for a phone in the
  PROXY header: addresses or ranges such as `"10.0.0.0/8"` or `"::1"`. By default it is loopback
  and the private ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`,
  `fc00::/7`, and their IPv4-mapped forms), which covers Caddy on the same machine or on Docker's
  network. A connection from anywhere else is closed before anything is read, and logged with
  its real address. Narrow it to the proxy's own address where you can, for example the Docker
  network's range.
- The relay reads only the PROXY header and the name in the TLS ClientHello (SNI, sent in clear),
  and passes everything after the header on unchanged.
- **No name, a name it doesn't pass through or a Ledung that is offline: the connection is
  closed.** There is no "This Ledung is offline" page for such a name, since the relay has no
  certificate to show one with; the phone shows a connection error.
- **A `"passthrough"` name is refused on the ordinary listener** (`421 Misdirected Request`), so
  a proxy still ending TLS for it fails loudly instead of quietly reading it. Agents without
  `"tls"` (or with `"tls": "proxy"`) work exactly as before, on the ordinary listener only.
- The relay logs a closed passthrough connection with its reason, the name and the phone's
  address from the PROXY header; never what goes through.
- The Ledung must end TLS itself for its public name (Ledung side: build plan steps 3 and 4 in
  `docs/steps/relay-e2e.md`); until it does, switch no agent to `"passthrough"`.

The proxy in front, with caddy-l4: a layer-4 listener wrapper in Caddy's `:443` that sends the
passed-through names, by SNI, to `tcp/<relay>:8443` with `proxy_protocol v2`, and every other name
on to Caddy as before (`docs/steps/relay-e2e.md`, piece 1, and the spike's Caddyfile).

## Limits

`limits` in the config: the largest message an agent may send (`maxFrameBytes`), phone connections
open at once through one Ledung (`maxStreamsPerAgent`), and failed agent sign-ins from one address
before it is turned away (`failedAttemptsPerAddress` within `attemptWindowSeconds`). A request head
over 16 KiB, or one that takes longer than `headTimeoutMs` (10 seconds) to arrive, is dropped. On the passthrough
listener the same goes for the PROXY header and ClientHello, and a ClientHello split over several
TLS records is refused (legal, but rare).

## Several users

Every Ledung is an entry of its own, with its own secret, host and owner; nothing in the relay is
about one person. A second connection with the same name replaces the first (the same Ledung back
after a dropped connection).
