# End-to-end encryption through the relay — proposal

Oct 18, 2026 · **Decided 2026-10-18 12:43: the recommended plan, choices A1, B1, C1, D1, E1 and F1 (see [Choices](#choices-decided)). Nothing built yet; the spike (#199) is done, see [Spike findings](#spike-findings-199)** (issue #160, the "Later" item of [relay.md](relay.md)). Desk research, reading the relay and Ledung code as merged on `main`, and the documentation of the tools named. The server was not looked at; what this says about it comes from relay.md (Caddy already serves HTTPS on 80/443 for several names). No server names, addresses or domains are written here: `<domain>` stands for the real one.

**Done when:** the phone opens the same `https://<word name>.l.<domain>` as today and the certificate it sees was issued to, and is held only by, the Ledung on the PC; a capture on the server of the phone's traffic shows only TLS records; the server's Caddy holds no certificate and no key for any Ledung name, and Let's Encrypt refuses to issue one to anyone except that Ledung; pairing, passkeys, the unlock window and the local page work as before; a certificate renews by itself while Ledung is running, and one that ran out while the PC was off renews within a minute of Ledung starting.

## What Martin asked for

> "what would it take to get the end-to-end step working? I feel like that is a good way of handeling things." (Martin, 2026-10-18 12:22)

Today TLS ends at Caddy on the server. Whoever controls the server (a break-in, or a relay operator who is not you) sees the device cookie and every page, and can serve the phone a doctored page that shows "allow `ls`" while it gets the passkey to sign the challenge for a different, sensitive call (relay.md, "Honest risks"). The passkey cannot see what the page shows. End-to-end closes that: the server carries bytes it cannot read or change.

## What has to keep holding

1. **Everything Ledung checks today stays in Ledung**: device cookie, Origin `https://<publicName>`, CSP, page key, passkey with the exact origin, unlock window (decisions 8 and 9). Nothing gets weaker because the transport changes, and nothing starts trusting the relay.
2. **Tunnel traffic counts as the public name** whatever it claims (#219, `Guard.markTunnel`). With TLS in Ledung the requests arrive on a TLS socket wrapped around the tunnel stream; it must still be marked.
3. **No admin rights, no firewall rule, no open port on the PC.** Everything still goes over the one outgoing WebSocket.
4. **Ledung's start never waits for the relay** (`src/main.ts`); now it must not wait for the certificate authority either.
5. **The relay stores no traffic, decides nothing about who may use a Ledung** and stays one small program (`relay/relay.ts`).
6. **Keys under the user data folder**, through `src/platform/paths.ts`; never in the repository, the config file or a release folder.
7. **Built for several people** (relay.md decision 7), used by Martin this week.

## The pieces

End-to-end needs three things to be true at once. Each is a part of the build.

1. **The server routes by name without ending TLS.** Caddy reads only the name in the TLS ClientHello (SNI, which is sent in clear) and passes the raw bytes to the relay.
2. **The relay passes TLS through.** It finds the agent by that same name and puts the bytes on that agent's stream, untouched.
3. **Ledung ends TLS itself**, with a certificate for its public name whose key never leaves the PC, and **nobody else can get one** for that name.

The third half of point 3 is the one that decides whether this is worth doing: without it, a malicious server operator simply gets its own certificate for the name and goes back to ending TLS itself (below, "What a malicious relay can still do").

### 1. Routing by name on the server

| | (a) caddy-l4 as a listener wrapper (recommended) | (b) HAProxy or nginx `stream` in front of Caddy | (c) A second IP address for the Ledung names |
|---|---|---|---|
| How | Caddy rebuilt with the `layer4` module (`xcaddy build --with github.com/mholt/caddy-l4`). In Caddy's own `:443` listener a layer-4 route peeks at the ClientHello: Ledung names go raw to the relay; everything else falls through to Caddy's HTTP app as today | A small proxy owns `:443`, reads SNI (`ssl_preread`), sends Ledung names to the relay and everything else to Caddy on a local port | Ledung names' DNS points at an additional IPv4 of the server; the relay listens on that address's port 443 itself; Caddy is told to bind only the first address |
| What changes for the other sites | Nothing: same Caddy, same certificates, same config blocks | Every site now goes through one more hop; Caddy needs the PROXY protocol switched on to keep client addresses | Caddy's bind address (one global option) |
| Moving parts | One Caddy, custom-built (a Dockerfile `FROM caddy:builder`) | A second proxy to run and update | An extra IP (a small monthly fee at Hetzner) |
| Risk | A third-party Caddy module, maintained by Caddy's author, in front of everything on 443; a bad build stops all sites until rolled back | Another program in front of everything on 443 | Least risk to the other sites |

**The Caddy change for (a)**, a sketch to check against the caddy-l4 version deployed (its `docs/examples/combining_apps.md` has this exact shape):

```caddyfile
{
	servers :443 {
		listener_wrappers {
			layer4 {
				@ledung tls sni *.l.<domain>
				route @ledung {
					proxy {
						proxy_protocol v2        # the phone's address, for the relay's logs and limits (#167)
						upstream tcp/ledung-relay:8443
					}
				}
			}
			tls
		}
	}
}

relay.<domain> {                       # the agents' WebSocket: TLS still ends here, as today
	reverse_proxy ledung-relay:8080
}

http://*.l.<domain> {                  # port 80 only redirects; Caddy gets no certificate for these names
	redir https://{host}{uri}
}
```

and the site blocks Caddy has today for the Ledung names are **removed**, so Caddy no longer holds their certificates. The `*.l.<domain>` pattern means a new Ledung needs no Caddy change; `gate.l.<domain>` (relay-home.md's outer gate, not built) would be caught by it too, see "What goes away". That is the end state. **On the way there** the matcher lists explicit names (first only the test name, then each switched name), because the wildcard would at once pass through today's names, which still need Caddy to end TLS until their Ledung is switched. For the same reason the "nobody" CAA record on `l.<domain>` (3b) goes in only once no name under it still needs Caddy's certificate.

### 2. The relay passes TLS through

A second listener in `relay/relay.ts` (port 8443, internal only), next to the HTTP one that stays for the relay's own name, `/health` and Ledungs not yet switched:

- Reads the PROXY protocol v2 header (the phone's address), then the TLS ClientHello, up to 16 KiB and 10 seconds as today; takes the `server_name` extension. About 80 lines, tested against ClientHellos recorded from Node, Chrome and Safari.
- Finds the agent by that name exactly as `route()` does by Host, opens a stream and sends the bytes **unchanged** (no `forwardHead`: there is no HTTP head to read).
- No SNI, an unknown name or an agent offline: the connection is closed. **There is no "This Ledung is offline" page any more** for a switched name: the relay has no certificate to show one with (relay-home's home page is where "offline" will show).
- Per agent, `"tls": "passthrough"` in the relay's config: such a name is refused on the plain HTTP listener, so a Caddy left half-configured fails loudly instead of quietly ending TLS for it.
- The mux protocol (`src/remote/mux.ts`) does not change; the hello stays at version 1.

### 3a. TLS inside Ledung

- **Where:** `LedungServer` gets a second, `https` server object that never listens on a port; `tunnelConnection()` hands each tunnel stream to it with `emit('connection', …)`, exactly as it hands them to the HTTP server today. Node wraps any `Duplex` in a `TLSSocket`, so the in-memory `duplexPair` works unchanged. It shares the request and upgrade handlers with the plain server. **The mark has to move:** `Guard.tunnelled` compares `req.socket` with the marked sockets, and behind a TLS server `req.socket` is the `TLSSocket`, not the `ours` end `tunnelConnection()` marks today. So the TLSSocket is marked too, on the server's `secureConnection`, before any request can arrive on it (or `tunnelled` looks through a TLSSocket to the stream under it). Everything that server receives came through the tunnel, but the guard only knows that through the mark (rule 2).
- **Which:** Ledung peeks at a stream's first byte. `tunnelConnection()` returns its end of the pair at once today, so with the peek the server end waits for the first chunk, `unshift`s it back, and only then goes to the HTTP or the HTTPS server with `emit('connection', …)`; the tunnel side does not change. `0x16` is a TLS handshake, anything else plain HTTP from a relay in today's mode. With `"remote": { …, "tls": "required" }` a plain stream is closed and Settings says why. That does **not** stop a malicious relay (it could end TLS with a certificate of its own and open TLS again towards Ledung; only point 3b stops that), but it makes a Caddy that still ends TLS for the name visible at once.
- **The ACME challenge:** a ClientHello whose ALPN list is `acme-tls/1` (Let's Encrypt validating, see 3b) goes to a separate TLS context holding the one-off challenge certificate, only while an order is open. Ledung reads ALPN from the same ClientHello it peeked at, with the parser the relay uses (shared in a small `src/remote/clienthello.ts` that, like `mux.ts`, imports only Node's own modules, so the relay's container can copy it).
- **The key and certificate** live in `<user data>/remote/`, a new `remoteDir()` in `src/platform/paths.ts`: `acme-account.key` (the ACME account, ECDSA P-256), `tls.key` and `tls.crt` (the full chain), `acme.json` (the account URL, the directory URL, the last order's state). Mode 0600 on macOS and Linux; on Windows the user profile's own permissions, as for `auth-token`. They survive releases (the data folder is not the release folder) and are never in the config, so the config can be shared without them.
- **Renewal without a restart:** `server.setSecureContext()` swaps the certificate in place; open connections keep the old one until they close.
- HTTP/1.1 only over the tunnel (ALPN `http/1.1`), as today; WebSockets unchanged.

### 3b. Certificates: who can get one for the name

| | (a) TLS-ALPN-01, an ACME account per Ledung (recommended) | (b) DNS-01 through Cloudflare's API |
|---|---|---|
| How Ledung proves the name | Let's Encrypt connects to the name on port 443 with ALPN `acme-tls/1`; Caddy routes it by SNI to the relay, the relay down the tunnel; Ledung answers with the challenge certificate. Only possible once pieces 1 and 2 work | Ledung writes a `_acme-challenge` TXT record with a Cloudflare API token |
| What the PC must hold | Its own ACME account key, nothing else | A Cloudflare token. Cloudflare tokens are scoped to a zone, not to one record: **every Ledung, and every other person's PC later, could rewrite the whole zone**, the server's other sites and the CAA records that are meant to protect it included |
| Several people | Each Ledung gets its own account; nothing shared | Either every PC holds a token for Martin's zone, or a challenge-delegation service (acme-dns) runs on the server, which puts the server back in the position to issue |
| Wildcards | No (not needed: one name per Ledung) | Yes |
| Works before passthrough | No | Yes |

**The lock: CAA records with the account.** A CAA record tells certificate authorities who may issue for a name, and Let's Encrypt honours two parameters on it (RFC 8657): `accounturi`, the one ACME account allowed, and `validationmethods`. Every public CA must check CAA before issuing. So, in Cloudflare:

```
l.<domain>                  CAA 0 issue ";"
l.<domain>                  CAA 0 issuewild ";"
copper7meadow4.l.<domain>   CAA 0 issue "letsencrypt.org; accounturi=https://acme-v02.api.letsencrypt.org/acme/acct/<the PC's id>; validationmethods=tls-alpn-01"
```

The first two mean nobody may issue for any name under `l.<domain>` that has no record of its own (CAA is looked up from the name upwards, the closest record wins), so a server operator cannot invent a sibling name either. The third allows exactly one ACME account, whose key is only on the PC. The server can still pass a TLS-ALPN-01 or HTTP-01 check for the name (it answers on that address), but Let's Encrypt refuses its account, and every other CA refuses outright. Settings → Remote shows the account URL with a Copy button, so the record is one paste in Cloudflare per Ledung.

**The account comes before the record.** The account URL exists only once Ledung has made its ACME account, and under the lock every order made before the record is pasted fails Let's Encrypt's CAA check. So Ledung makes the account, then waits in a state of its own, **"Waiting for the CAA record"**: it shows the record to paste, looks the name's CAA up itself every minute (Node's `dns.resolveCaa`, no request to Let's Encrypt, so no failed validations and no back-off) and orders as soon as its own account URL is in it, or at once on a **Check now** button. The 1/5/30-minute back-off is only for failures after that. Staging and production are different directories with different accounts and account URLs (`acme-staging-v02…/acct/…` and `acme-v02…/acct/…`), so going from one to the other means a new record.

**The library:** `acme-client` (5.4, maintained, uses Node's own crypto for keys and signatures; it has `createAlpnCertificate` for the challenge certificate). It pulls in `axios`, `@peculiar/x509` and `asn1js`. Certificate handling is security code, so a package rather than our own, as decision 4 chose for passkeys. It must be bundled by `npm run pack` like the other dependencies.

**Lifetimes and renewal.** Let's Encrypt issues 90-day certificates by default today, 64 days from 10 February 2027 and 45 days from 16 February 2028 (its announced plan; the opt-in `tlsserver` profile already gives 45). Ledung checks at start and every 12 hours and renews at two-thirds of the lifetime, so the slack shrinks from 30 days to about 15. It uses ACME Renewal Information if `acme-client` gives access to it, and requests the default profile, not the 6-day one.

**Rate limits** that matter: 50 new certificates per registered domain per week, shared by every Ledung under `<domain>` (renewals are not blocked by it); 5 certificates per week for exactly the same name, which is why Ledung keeps and reuses its key and certificate and never orders again on every start; 5 failed validations per account and name per hour, so failures back off (1 min, 5, 30, then hourly). Development uses Pebble on this machine; the first run against the real thing uses Let's Encrypt's **staging** directory (`"acme": "staging"` in the config) on a test name, and production is used only once staging has worked there (build plan, step 6).

**While Ledung is offline** nothing renews, and nothing needs to: the phone cannot reach an offline Ledung anyway. A certificate that ran out while the PC was off is renewed in the first minute after the tunnel connects; until then the phone gets a certificate error rather than the page. Settings shows "Certificate valid until …", "renewing", or "renewal failed: …", and the page warns when fewer than 7 days are left.

**Several people (relay-home.md).** Each Ledung orders its own certificate with its own account, so nothing in the relay or on the server is shared or secret. Two limits, written down honestly:
- **Whoever controls the DNS can always get a certificate**, by changing the CAA record and using DNS-01. For names under Martin's domain that is Martin's Cloudflare account. Someone else using Martin's relay under Martin's domain trusts Martin's DNS account (not his server). Anyone who doesn't want to can use a domain of their own: the relay's config already takes any `host` per agent.
- **Adding a person's Ledung needs a CAA record**, written by whoever runs the domain. Fine by hand for a handful of people. Giving the relay a Cloudflare token to do it at enrolment would let the server write CAA and so authorize itself, which undoes the lock; if that is ever wanted, the protection falls back to detection (below, certificate log watch).

## Recommendation

**Route with (a) caddy-l4, issue with (a) TLS-ALPN-01, lock with CAA plus the account, and give the two Ledungs new names on the switch.** In that order: relay passthrough, Ledung's TLS and its ACME client first, proven with self-signed certificates and Pebble (Let's Encrypt's test server, run locally) and no server change; then the server change for **one throwaway test name** only, and the first real ACME run (staging, then production) on that name; then the switch of the real Ledungs, one at a time. Let's Encrypt, staging included, validates TLS-ALPN-01 by connecting from the internet to the name on port 443, so no real ACME run can happen before the server routes a name to the relay.

- Why caddy-l4 over a second proxy or a second IP: the other sites keep running exactly as they do, and adding a Ledung later needs no server change. The second IP is the fallback if a custom Caddy build is unwelcome on that server.
- Why TLS-ALPN-01 over DNS-01: no secret on the PC that could rewrite the zone, and it works for every person without a delegation service on the server.
- Why the CAA lock is not optional: without it, end-to-end protects only against someone who reads the server's traffic without acting. A server operator who acts gets a certificate of its own in minutes and is back where it is today, and the passkey trick from relay.md works again.
- Why new names: the server's Caddy already holds valid certificates for today's names; if they were issued when the relay went up (17 October), they are valid until about mid-January. CAA does not take back a certificate already issued, and revoking it barely reaches phones (browsers hardly check revocation since Let's Encrypt ended OCSP). New names cost one QR pairing and one passkey per phone and computer (the passkey's RP ID is the public name as built, `src/server/passkeys.ts`), about ten minutes for Martin this week. Keeping the names leaves a window of up to three months in which a break-in on the server could still use the old certificate.

## What the relay still sees, and can still do

**Sees:** which name is opened (SNI is sent in clear; Encrypted Client Hello would hide it, but it is not something Ledung or the relay can switch on in a useful way here), the phone's IP address, when, and how many bytes go each way; which Ledungs are online; its own agents' secrets (TLS for `/agent` still ends at Caddy, which is fine: a secret now gets only encrypted streams, see the threat model); later, the home's accounts and, if turned on, the counts (relay-home.md).

**Can still do:**
- **Denial of service:** drop, delay or refuse any connection, take a Ledung offline for the phone, or lie on the home about what is online. Not preventable; the local page is unaffected.
- **Get a certificate of its own for a name:** only if the CAA lock is missing or someone changes it in Cloudflare. Then it is back to today's position. CAA in Cloudflare is the line; the Cloudflare account's own sign-in (passkey, two-factor) is what holds it.
- **Use an old certificate** issued before the switch, until it runs out: the reason for new names.
- **Phish from a page of its own:** the relay's home (later) and the server's other sites are its own origins. A page there can show anything, but a passkey assertion made there carries that origin, and Ledung accepts only `https://<its public name>` (`Passkeys.origin`). That exact check must stay, also when the combined view (relay-home decision 3) widens it to the owner's other Ledung names: the list it widens to must hold only names the CAA lock covers.
- **Traffic analysis:** sizes and timing hint at activity (a long answer, a chat open). Accepted.

**Pinning on the phone does not help, and is not possible:** browsers removed HTTP Public Key Pinning (Chrome in 2018–2019; Safari never had it) and Expect-CT, and a web page cannot pin the certificate of the site it is on. Only a native app could. CAA with the account plus the certificate log watch is what a web page can have.

## Honest risks

- **CAA is in DNS, and DNS is Cloudflare.** The trust moves from "the server" to "the Cloudflare account and Let's Encrypt". That is a smaller, better-guarded target (no public services run there, it has its own passkey sign-in), but it is not nothing.
- **Losing the account key means new CAA records.** A reinstall, a new data folder or a deleted `remote/` folder makes a new ACME account; until Martin pastes the new account URL into the CAA record, the Ledung cannot get a certificate. Settings says exactly that. Backing up `<user data>/remote/` avoids it.
- **A custom Caddy in front of every site on 443.** A broken build or a caddy-l4 bug stops the other services too. Keep the old image to roll back to, and switch on a quiet evening.
- **Offline looks like an error.** With the name passed through, the relay cannot show "This Ledung is offline": the phone shows a connection error. The home page (relay-home.md, step 1 there) is where that will be shown properly.
- **Shorter lifetimes, more moving parts.** By 2028 a Ledung offline for a month and a half comes back with an expired certificate every time. Renewal on connect handles it in under a minute, but it is one more thing that can fail at the moment Martin needs the phone. The page warning and Settings make it visible from the PC.
- **More security code in Ledung:** `acme-client` and its dependencies, a ClientHello parser, TLS settings. The parser reads untrusted bytes (from the relay, and in the relay from the internet): fuzz it with truncated and oversized input, as the tests below do.
- **What goes away:** relay-home's outer gate (decision 4 there, not built) cannot work on passed-through names: the relay no longer sees cookies. The device cookie and passkey already stand alone, as relay.md designed; the gate was "extra protection only".

## Threat model, after

Rows not listed (someone on the internet, a copied device cookie, a stolen phone) are unchanged from relay.md: they never depended on where TLS ends.

| Who / what | Gets | Can they approve a sensitive call? |
|---|---|---|
| The relay operator / a break-in on the server, **with the CAA lock** | Names opened, addresses, timing and sizes; can block | **No.** No certificate for the name, so no page of its own and no reading |
| Same, **without the CAA lock** | Can get a certificate in minutes and end TLS again: today's position. The certificate shows up in public certificate logs | Possibly, as today |
| Same, **with an old certificate** from before the switch (names kept) | Today's position until it runs out (about three months) | Possibly, as today. New names close this |
| A leaked tunnel secret | Can connect as that Ledung and receive the phone's connections, but cannot answer the TLS handshake without the Ledung's key: the phone sees a certificate error. No cookie, no page, no reading | **No** (with the CAA lock) |
| Martin's Cloudflare account | Can change CAA and DNS and issue a certificate for any name under `<domain>` | Possibly. Its sign-in is the line |
| A thief of the PC's data folder | The TLS key and the ACME account: can impersonate the Ledung to a phone, if they also hold its tunnel secret or the server | The same as having the PC; nothing new |

## Choices (decided)

Martin, 2026-10-18 12:43, Ledung question #279: "a — Go with the recommended plan", so **A1, B1, C1, D1, E1 and F1**, the first option of each below. His note: "Remember that we have the web-infra manager that can do a lot of the things as well. Get started on this before to many ppl are starting to use remote controll via phone on ledung. (So far its only me)". Recorded in [decisions.md](../decisions.md). The other options stay below for the record.

**A. How the server routes by name.**
- *A1, caddy-l4 as a listener wrapper (recommended):* the other sites are untouched, new Ledungs need no change. Cost: a custom-built Caddy in front of all sites on 443; ~45 min on the server.
- *A2, HAProxy or nginx in front of Caddy:* no custom Caddy. Cost: a second proxy in front of every site, PROXY protocol switched on in Caddy; ~1 h.
- *A3, a second IP address for the Ledung names:* least risk to the other sites. Cost: a small monthly fee, a Caddy bind change, DNS for the names to the new address; ~45 min.

**B. How Ledung gets its certificate.**
- *B1, TLS-ALPN-01, an ACME account per Ledung (recommended):* nothing secret on the PC but its own key. Cost: needs the passthrough working first.
- *B2, DNS-01 with a Cloudflare token:* works before passthrough. Cost: every PC with that token can rewrite the whole zone, the CAA lock included; not workable for other people.

**C. The CAA lock.**
- *C1, CAA with the account on each name, and "nobody" on `l.<domain>` (recommended):* a server operator cannot get a certificate. Cost: one record per Ledung pasted in Cloudflare by Martin; a new record after losing a Ledung's data folder.
- *C2, no CAA:* nothing to maintain. Cost: end-to-end then stops only a server that reads without acting; an active one gets its own certificate.

**D. Today's names.**
- *D1, new names on the switch (recommended):* closes the old-certificate window. Cost: the bookmark changes; pair each phone again (one QR per computer) and register its passkey again, about ten minutes. The passkey part holds for the RP ID as built (the full public name, `src/server/passkeys.ts`). If relay.md's choice C1 (the shared parent domain, settled by relay-home decision 3) is built first, passkeys survive a rename under the same parent and D1 costs only the QR pairing.
- *D2, keep the names:* the URL, the pairing and the passkeys stay. Cost: Caddy's certificates for those names stay valid until about mid-January, and a break-in on the server could use them until then.

**E. Certificate log watch** (optional, can come later).
- *E1, later, as its own issue (recommended):* Ledung looks up its name daily in the public certificate logs and warns on the page if a certificate it did not order appears. Detection, not prevention; useful mainly if C2 is chosen or for other people's names. Cost: ~1.5 h; it sends the name (already public in those logs) to a log search service.
- *E2, with the first build.*
- *E3, never.*

**F. Other people's Ledungs** (relay-home, decision 7). No work either way now.
- *F1, under Martin's domain, Martin writes their CAA records by hand (recommended for now):* they trust Martin's Cloudflare account, not his server.
- *F2, each brings a domain of their own:* they trust nothing of Martin's. Cost: their own DNS setup; the relay already supports it.

## What stays the same for Martin

- **The URL's shape**, `https://<word name>.l.<domain>`, no port; the same name if D2 is chosen, a new one with D1.
- **Pairing** (one QR per computer, Settings → Devices), **passkeys** (Face ID for sensitive calls), **the 30-minute unlock**, decisions 8 and 9: all unchanged. With D1 each is done once more for the new name.
- **The local page** at `127.0.0.1` and on `"lan"`: untouched; no certificate is used there.
- **No admin rights, no firewall rule**; the relay's `/health` and the agents' sign-in as today.
- New: Settings → Remote shows the certificate's state and, once, the account URL to paste into Cloudflare; the phone shows a connection error instead of the "offline" page when the PC is off.

## Spike findings (#199)

Oct 18, 2026, on one Windows PC, natively: no Docker, no admin rights, no hosts file, no real DNS, nothing on the server, no Let's Encrypt. Caddy v2.11.7 with caddy-l4 v0.1.2 (the Windows build from Caddy's download service), Pebble v2.10.1 and its mock DNS server `pebble-challtestsrv`, `acme-client` 5.4.0, Node 24. The [spike's README](relay-e2e-spike/README.md) has the versions and the sha256 of every file the run used, and `fetch.sh` checks them before it runs anything it downloaded. Everything listened on 127.0.0.1 only, on ports 51053–51481 (Windows reserves 50000–50359 on this machine, see below). The files and the full output are in [relay-e2e-spike/](relay-e2e-spike/): `fetch.sh` downloads the tools into `.test/spike/` (git-ignored), `run.sh` starts them, runs `spike.ts` and stops them again by port. The last run passed all 11 checks ([run-output.txt](relay-e2e-spike/run-output.txt)).

`spike.ts` plays three parts in one process. **A relay**: the agents' WebSocket, plus a passthrough listener that reads Caddy's PROXY v2 header and the ClientHello and puts the raw bytes on that agent's stream, using `src/remote/mux.ts` unchanged. **A Ledung**: each stream becomes a `duplexPair` end, as `tunnelConnection()` makes it today, and goes to an `https` server that never listens. **A phone**: a TLS client to Caddy's "443" with the Ledung's name as SNI.

### What the spike proved

1. **caddy-l4 routes by SNI without ending TLS, and the other sites keep working.** The Caddyfile shape in piece 1 works as written: `listener_wrappers { layer4 { @ledung tls sni *.l.test; route @ledung { proxy { proxy_protocol v2; upstream tcp/…:51444 } } } tls }`. The wildcard SNI match works. An ordinary site (`site.test`, TLS ended by Caddy) on the same port went on being served by Caddy. A name under the pattern that no Ledung serves goes to the relay, which closes the connection: the phone sees "disconnected before TLS was established", not a Caddy certificate. Port 80 for a Ledung name only redirected to `https` (302). The spike's Caddyfile is [relay-e2e-spike/Caddyfile](relay-e2e-spike/Caddyfile).
2. **PROXY v2 reaches the relay** before the ClientHello: the relay logged the client's address and port for the phone and for Pebble's checks. That is what #167's per-address cap can read.
3. **TLS ends in Ledung, over the tunnel, and the relay carries only TLS records.** With a self-signed certificate the phone completed TLS with the Ledung and got the page. Everything the relay carried for that connection, both ways, parsed as well-formed TLS records and nothing else: 1766 bytes in 4 records up, about 2620 bytes in 10 records down, only handshake, change-cipher-spec and application-data records (TLS 1.3). The page's text (a random marker) did not appear in those bytes. A WebSocket over the same path worked too.
4. **The first-byte peek works as 3a describes:** the Ledung end of the pair waits for the whole ClientHello, `unshift`s it back and only then goes to the HTTPS server (or the challenge context) with `emit('connection', …)`. Neither the mux nor the tunnel side changed.
5. **Review finding 4a is real, and the fix in 3a works.** `req.socket` in the request handler is the `TLSSocket`, not the `duplexPair` end that `tunnelConnection()` marks today, so today's mark alone would miss every TLS request. Marking the TLSSocket on the server's `secureConnection` covered both the request and the WebSocket upgrade.
6. **TLS-ALPN-01 through the whole path works.** `acme-client` made an account and an order at Pebble, built the challenge certificate with `createAlpnCertificate`, and Pebble's check connected to Caddy's port with SNI = the name and ALPN `acme-tls/1`. Caddy passed it through, the relay put it on the tunnel, and Ledung picked the challenge context by the ALPN it had peeked and answered. Pebble validated, the order was finalized and the chain downloaded. Pebble checks from three connections at once (as Let's Encrypt checks from several places), so the challenge context must answer every connection while the order is open, not just the first.
7. **The certificate is swapped without a restart.** After `setSecureContext()` with the Pebble key and chain, the next phone connection got the Pebble-issued certificate (issuer "Pebble Intermediate CA").
8. **Ledung can look up CAA itself.** Node's `dns.Resolver.resolveCaa` against the mock DNS returned the records as set, `accounturi` and `validationmethods` included, in one string (`"pebble.letsencrypt.org; accounturi=…; validationmethods=…"`). So the "Waiting for the CAA record" check is one lookup plus parsing that string. The check looks up the name's own record: the Ledung needs its own record anyway, so there is nothing higher up to climb to.

### What turned out wrong or missing in the proposal

- **Pebble does not check CAA at all**, so the CAA lock cannot be proven locally. Pebble's `caaIdentities` setting only goes into its directory and the DNS-PERSIST-01 challenge. Its validation makes no CAA lookup (its source, `wfe/wfe.go` and `va/va.go` at v2.10.1). The spike set five CAA records on the mock DNS, and Pebble issued every time: a sibling name under a parent with `issue ";"`, a second account against an `accounturi` naming the first, `validationmethods=dns-01` against a TLS-ALPN-01 check, a record naming another CA, and the name's own correct record. Its output lists them as `INFO` lines. **The lock is first proven in build plan step 6 against Let's Encrypt staging**, with a negative test (a second account must be refused). Step 4's test checks the "Waiting for the CAA record" state through Ledung's own lookup, not through a refusal from Pebble. Both steps are amended above.
- **A `servers` block must name the listener address exactly.** With the listener bound to an address (the spike's `default_bind 127.0.0.1`), `servers :51443 { listener_wrappers … }` silently matched nothing. Caddy started without the layer-4 route and ended TLS for the Ledung name itself (TLS alert 80, "internal error": it has no certificate for it). The key had to be `servers 127.0.0.1:51443`. This was seen while building the rig and is not in `run-output.txt`: the committed Caddyfile has the working key, so a rerun does not show it. On the server Caddy listens on `:443`, so `servers :443` should match, but step 5 should check it: `caddy adapt --config Caddyfile | grep listener_wrappers` must show the layer-4 route before the new image goes live.
- **`setSecureContext()` takes only the key and certificate.** The server's ALPN (`http/1.1`) stays as set when the server was made. Passing `ALPNProtocols` to it is a type error. No change to 3a, just how it is called.
- **Docker was not needed.** The plan said "a throwaway Docker network". Native binaries do the same with no admin rights. This matters for issue 4's loopback test, which can use the same `fetch.sh` / `run.sh` approach on Windows and macOS. CI still has no Pebble.
- **Pebble's account URLs look different** (`https://<pebble>/my-account/<id>`) from Let's Encrypt's (`…/acme/acct/<number>`). Ledung must show and compare the URL `acme-client` returns, never build or pattern-match it.
- **Windows reserves port ranges** (here 50000–50359, among others; `netsh interface ipv4 show excludedportrange protocol=tcp`), and binding inside one fails with "access forbidden". This hits test ports, not Ledung: worth knowing when picking ports for loopback tests.
- About the ClientHello: the one from Node fitted in one TLS record, and the parser has to buffer across TCP chunks (it did). Browsers with post-quantum key shares send about 1.8 KB (from memory, not measured here), still one record. A ClientHello split over several records is legal but rare: refuse it rather than reassemble it.

The architecture held: the routing, the passthrough, TLS in Ledung on the existing tunnel streams, the peek and TLS-ALPN-01 all worked as written, and the mux and the tunnel need no change. What changed is **where things are tested and some details of how they are built**: the CAA lock is tested in step 6, not with Pebble (steps 4 and 6 amended above); the loopback test needs no Docker; and the points below for each issue.

### Not tested by the spike

- **No real browser.** The "phone" was a Node TLS client (and curl for the ordinary site). No Safari or Chrome handshake ran: their ClientHello size, ALPN order and post-quantum key shares are untested against the parser and Caddy's matcher.
- **No IPv6.** Every listener was on 127.0.0.1 and the mock DNS answered no AAAA, so nothing went over IPv6.
- **Not the server's Caddy.** The Windows build of the same version ran, not the Linux image the server will run, and not inside Docker, not next to the server's real sites and config.
- **No CAA refusal was observed.** In each `INFO` line, the "Let's Encrypt refuses/issues" half is the spike's own reading of the CAA rules (RFC 8659, RFC 8657), not something any server did. Only "Pebble ISSUED" was observed.
- **No Let's Encrypt, no real DNS, no internet path**: validation from several places on the internet, Cloudflare's DNS and the server's firewall are first met in step 6.
- **One machine, short runs**: no load, no long-lived connections, no renewal over time, no network drops between relay and Ledung while a TLS session is open.

### Effect on the issues

What each build issue takes from the spike. Each issue's body carries the same list, under "From the spike (#199)".

- **#200, relay passthrough (step 2):** the PROXY v2 header comes before the ClientHello. Buffer the ClientHello across TCP chunks, and refuse one split over several TLS records. A name under the pattern with no Ledung online is closed, with no page. TLS-ALPN-01 checks arrive as several connections at once (three from Pebble), each a separate stream. `spike.ts` has a working sketch of both parsers. Loopback test ports: Windows may reserve ranges (`netsh interface ipv4 show excludedportrange protocol=tcp`).
- **#201, Ledung TLS on tunnelled streams (step 3):** mark the `TLSSocket` on the HTTPS server's `secureConnection`. `req.socket` is the TLSSocket, so today's mark on the duplexPair end alone misses every TLS request (proven). The peek waits for the whole ClientHello, `unshift`s it, then calls `emit('connection')`. `setSecureContext()` takes only key and certificate, and ALPN stays as set on the server. WebSocket upgrades work over the same path.
- **#202, certificates by ACME (step 4):** the loopback test needs Pebble **and** `pebble-challtestsrv` (mock DNS, with Pebble started with `-dnsserver` pointing at it), with Pebble's `tlsPort` set to the relay route's port. No Docker is needed: `fetch.sh` / `run.sh` show how. Pebble never checks CAA, so the "Waiting for the CAA record" test checks Ledung's own `resolveCaa` lookup against the mock DNS (whose `/add-caa` sets records), not a refusal from Pebble. Show and compare the account URL `acme-client` returns, and never build or pattern-match it (Pebble's look different from Let's Encrypt's). The challenge context must answer every check connection while the order is open. Pebble's API needs its own root trusted (`NODE_EXTRA_CA_CERTS` in the spike).
- **Step 5 (server) and step 6 (first real run)** are written out above: the `caddy adapt` check, and the negative CAA test with a second account.

### The first server step for a real Let's Encrypt staging test (one test name)

Build plan step 5, made concrete by the spike. Nothing else on the server changes, and today's Ledung names keep their site blocks and certificates:

1. **A Caddy image with caddy-l4**: a Dockerfile `FROM caddy:builder` running `xcaddy build --with github.com/mholt/caddy-l4`, then copied into `FROM caddy`, the same Caddy version as today. Keep the old image tagged to roll back to.
2. **The layer-4 route for one explicit name**, in the global options of today's Caddyfile: `servers :443 { listener_wrappers { layer4 { @e2e tls sni e2e-test.l.<domain>; route @e2e { proxy { proxy_protocol v2; upstream tcp/ledung-relay:8443 } } } tls } }`. If today's Caddyfile already has a `servers` block for that listener, the wrapper goes inside it. Before going live, `caddy adapt` must show the `layer4` wrapper (see the trap above). Add a port-80 block for the name that only redirects.
3. **The relay with its passthrough port 8443** on the internal Docker network only (no published port), from issue 2's build, and the test name in its config as an agent with `"tls": "passthrough"` and a secret of its own.
4. **DNS for the test name** to the server, if no wildcard record already covers it. If the name has an AAAA record, Let's Encrypt tries IPv6 first when it validates (from its documentation as remembered, not tested here), so Caddy must answer on the server's IPv6 address too (`:443` listens on both). No CAA change on `l.<domain>` yet: the CAA record for the test name comes in step 6, with the staging account URL from the throwaway Ledung.
5. **Check:** the other sites still answer; `https://e2e-test.l.<domain>` with no Ledung connected closes the connection instead of showing a Caddy certificate; the relay's log shows the PROXY address. Then step 6 starts.

## Step 6 findings (#214)

Oct 18, 2026, 18:20–19:24 local time (UTC+2). A throwaway Ledung on this PC (test port, own config and data folder) connected to the server's relay as agent `e2e-test`, with `"tls": "required"`, for the name `e2e-test.l.projectledung.com`, which step 5 (#210) routes through Caddy-l4 to the relay. web-infra set the CAA records, on Martin's word (question #296). One staging and one production certificate were issued, as planned, and nothing failed.

1. **Staging.** With `"acme": "staging"` Ledung made its account at once on connecting and showed "Waiting for the CAA record" with the exact record. Once web-infra had added it, Check now ordered, and the certificate came within seconds through Caddy-l4, the relay and the tunnel by TLS-ALPN-01. From outside, `openssl s_client` showed issuer `(STAGING) Baloney Bulgur YE2`, SAN `DNS:e2e-test.l.projectledung.com`, valid 2026-10-18 15:31 to 2026-12-21 15:31 UTC. That is 64 days: staging now issues shorter certificates than production does, and Ledung renews at two-thirds of whatever it gets. The page answered 401, as it should for an unpaired device.
2. **The CAA lock holds: Let's Encrypt refused a second account that had passed the domain check.** Let's Encrypt checks CAA only **after** the domain check has passed (Boulder `ra/ra.go`, `checkDCVAndCAA`: CAA "is only checked if DCV is successful"). So a second account that never answers its challenge fails on the connection and proves nothing about CAA, and the negative test as planned could not work. The test was run as the threat it stands for, a server operator in the path who can answer the check. With the test Ledung stopped, a throwaway script connected to the relay as the agent, made a fresh staging account, ordered the name and answered TLS-ALPN-01 itself with that account's own challenge certificate. Let's Encrypt connected 5 times (over IPv6 first: `addressUsed 2a01:4f9:c014:a328::1`), the check passed, and then: `urn:ietf:params:acme:error:caa`, "While processing CAA for e2e-test.l.projectledung.com: CAA record for e2e-test.l.projectledung.com prevents issuance", status 403. The script never finalized anything, and its account is in no record. After a restart the test Ledung served the same staging certificate as before.
3. **Bug, fixed in #214's PR: switching `"acme"` from staging to production kept the staging certificate.** Ledung counted any valid certificate for the name as "nothing to order", so after the switch it went on serving the untrusted staging one until renewal, weeks later, and never even made the production account. `acme.json` now keeps the directory the certificate came from (`issuedBy`). A certificate from another directory is treated like a missing one: Ledung makes the new account, shows its record, and orders once the record names it, while the old certificate stays in use until then. A certificate with no `issuedBy`, put there by hand or issued before this fix, is used as it is, as before. The test data folder had been issued before the fix, so its `issuedBy` was added by hand for this run, with the value the fix writes.
4. **Production.** After the switch: a new account (`…/acme/acct/<number>` at `acme-v02`), "Waiting for the CAA record" naming the staging record it found, then, once web-infra had replaced the record, a certificate within seconds. From outside, without `-k`: serial `0647D9ABE6E84F13B0EAC3B67B23C81C053A`, issuer `Let's Encrypt YE2`, chain `YE2` → `Root YE` → `ISRG Root X2` → `ISRG Root X1`, `Verify return code: 0 (ok)`, TLS 1.3, valid 2026-10-18 15:46 to 2027-01-16 15:46 UTC (90 days). `curl` without `-k` got HTTP 401 with verify 0.
5. **The phone: pass.** Martin, 18:53, over mobile data, opened the name with no certificate warning and got Ledung's own page: "This device is not paired with Ledung. Pair it from Settings → Devices in Ledung on the computer."
6. **Capture on the server: pass, the relay carries only TLS records.** web-infra captured tcp/8443 on the server's Docker bridge, the hop from Caddy to the relay, from 17:01:59 to 17:21:59 UTC: 200 packets, none dropped. Its full outputs are in the manager's comment on #214. Meanwhile this PC sent 5 requests over IPv4, with `curl` without `-k`, each HTTP 401 with the certificate verified. Two of them carried a marker in the path (`/e2e-capture-marker`, also as a query). The capture shows:
   - 9 connections, all from Caddy (172.18.0.2) to the relay (172.18.0.18:8443);
   - TLS record types 20, 22 and 23 only, no alerts;
   - the only bytes that aren't TLS are the 28-byte PROXY v2 header (TCP over IPv4) at the start of each stream;
   - the only readable string is `http/1.1`, the ALPN in the ClientHello: no `GET`, `Host`, cookie, `ledung_` or HTML, and the marker 0 times;
   - the name only as the SNI in the ClientHello, and TLS 1.3 in every ServerHello.

   Not covered: IPv6, since no connection in the window came over it. The pcap was deleted afterwards.
7. **Taken down afterwards, on Martin's word** (20:06, Ledung question #321: "a — Take it down"). The test Ledung was stopped and its data deleted. web-infra removes the test name's layer-4 route and its CAA record.
8. **Smaller observations.** The account key is one per Ledung and is used at both directories (one account each). `nslookup` on Windows can't ask for CAA; Node's `resolveCaa` saw each record as soon as it was in. Let's Encrypt checks over IPv6 first when the name has an AAAA record, and that path works. This PC has no IPv6 route, so a client-side IPv6 test is still missing.

## Build plan

Ordered so that each part works and is tested on its own. Steps 1–4 are code, proven with self-signed certificates and Pebble on this machine and no server change. Step 5 is the first server change, for one throwaway test name only, and step 6 is the first run against the real Let's Encrypt: it cannot come earlier, because Let's Encrypt (staging too) validates by connecting from the internet to the name on port 443. Only step 7 touches the real Ledungs. Times are for one worker session. The server and DNS work in steps 5–7 can be done by Martin's server manager (web-infra) on his word instead of by Martin by hand; releasing and restarting Ledung stay Martin's call.

**1. Spike (~2 h, research; #199; done, see [Spike findings](#spike-findings-199)).** Natively on one computer, in the end without Docker: Caddy built with caddy-l4 routing `*.l.test` by SNI to a relay on 8443 with PROXY v2; Node `https` over a `duplexPair` with a self-signed certificate; `acme-client` against Pebble (Let's Encrypt's test server) answering TLS-ALPN-01 through the tunnel. Confirms the Caddyfile syntax, the wildcard SNI match and that Pebble's check reaches Ledung. Writes the findings into this file.

**2. Relay: TLS passthrough (~2.5 h).** The 8443 listener, the PROXY v2 header, the shared ClientHello parser (`src/remote/clienthello.ts`, copied into the container like `mux.ts`), per-agent `"tls": "passthrough"` (refused on the HTTP listener), the README and example config. #167's per-address cap then reads the PROXY header's address.
*Test:* `test/relay.test.ts`: a TLS connection through the relay reaches a fake agent byte for byte (the agent completes the handshake, the relay cannot); unknown SNI and offline agent close the connection; a passthrough name is refused on the HTTP listener; the parser on recorded ClientHellos, on truncated, oversized and garbage input, and without SNI.

**3. Ledung: TLS on tunnelled streams (~2.5 h).** The second `https` server in `LedungServer`, the first-byte peek, `"tls": "required"`, `remoteDir()` in `paths.ts`, loading `tls.key`/`tls.crt`, `setSecureContext` on change, the guard marking for TLS sockets, the CSP and cookies as today.
*Test:* with a self-signed certificate made in the test: a request and a WebSocket through relay and tunnel over TLS; the guard treats them as the public name (the device-cookie, Origin and passkey cases of `test/server-security.test.ts` repeated over TLS); a plain stream with `"required"` is closed; a certificate swapped while a connection is open; a missing certificate closes TLS streams and leaves the local page working.

**4. Ledung: certificates by ACME (~3.5 h).** `acme-client` (new dependency, bundled by `pack`), the account key and `acme.json`, ordering after the tunnel connects (never before `listen`, never holding up the start), the `acme-tls/1` route with the challenge certificate, the **"Waiting for the CAA record"** state (3b: shows the record, looks it up every minute and on Check now, orders only once the account URL is in it), renewal at two-thirds (12-hourly check, ARI if available), back-off on failures after that, `"acme": "pebble" | "staging" | "production"` (a directory URL for Pebble), Settings → Remote: certificate state, account URL and the record to paste. CHANGELOG bullet.
*Test:* with `acme-client` replaced by a fake in unit tests, and against a local Pebble in a loopback test (not in CI, which has no Pebble; the TLS-ALPN-01 check reaches the throwaway Ledung through a local relay, as in the spike): an order completes and the certificate is used without a restart; with no matching CAA record nothing is ordered and the state says so, and pasting it starts the order within a minute or on Check now (Pebble does not check CAA, so this is Ledung's own lookup against the mock DNS that comes with Pebble, not Pebble refusing; see the spike findings); a start with a valid certificate orders nothing; one past two-thirds renews; a failed validation backs off; an expired certificate renews on connect.

*Built (#202):* `src/server/acme.ts`; unit tests in `test/acme.test.ts`; the loopback is `test/loopback/acme-pebble.ts` (Pebble, its mock DNS and the relay, no Caddy: a small PROXY v2 front stands in for caddy-l4). Found there: for a key that already has an account, `acme-client`'s `createAccount` with the terms sends them as an account update, which Pebble refuses, so Ledung looks the account up with `onlyReturnExisting` first. And a CA reuses an authorization still valid from the last order (Let's Encrypt for 30 days, Pebble at random unless `PEBBLE_AUTHZREUSE=100`), so a renewal's order comes back already "ready": the certificate must be fetched with the order `finalizeOrder` returns, not the first one. `acme-client` 5.4 has no ACME Renewal Information, so renewal is at two-thirds only.

**5. Server, first slice: one test name (~45 min; a Ledung session writes the exact files, and Martin's server manager (web-infra) applies them on his word, or Martin by hand).** After 2–4 are merged. Build the Caddy image with caddy-l4 and keep the old image to roll back to; deploy the relay with its 8443 port on the internal network; add the layer-4 route for **one explicit throwaway name** (for example `e2e-test.l.<domain>`, not the wildcard, so today's names keep working as they are) and the port-80 redirect for it; the name in DNS to the server if no wildcard record covers it; the name in the relay's config as an agent with `"tls": "passthrough"` and its own secret. Today's Ledung names and their site blocks stay untouched. Check the other sites still answer.

**6. First real ACME run on the test name (worker with Martin's server manager, ~1 h).** A throwaway Ledung on a test port, as that agent, with `"acme": "staging"`: it makes its account and waits for the CAA record; the server manager, on Martin's word, or Martin adds the CAA record with the **staging** account URL for the test name; it gets a staging certificate through the server (the phone would show a warning: staging certificates are not trusted). Then `"acme": "production"`: a new account, so the record is replaced with the **production** account URL; a real certificate; the phone opens the test name over mobile data without a warning, and a capture on the server shows only TLS records. **This is also the first place the CAA lock itself can be proven**, because Pebble does not check CAA: with the staging record in place, a second, throwaway staging account (standing in for a server operator) orders the test name and must be refused. Bugs found here go back into 2–4 before step 7. Afterwards the test name's route, agent and records can go, or stay for the next test.

*Done (#214):* see [Step 6 findings](#step-6-findings-214). The negative CAA test had to answer the challenge, because Let's Encrypt checks CAA only after the check passes. One bug was fixed: a switch from staging to production kept the staging certificate.

**7. Switch, one Ledung at a time (a worker with Martin's server manager, ~45 min each; Martin pairs the phone).** With D1, a new name: added to the relay's config with `"tls": "passthrough"` and to the layer-4 route; release with `"tls": "required"` and `"acme": "production"` and restart (Martin's call); Settings shows the record; the server manager or Martin adds it in Cloudflare; within a minute Ledung has its certificate; pair the phone and register its passkey; check the Done-when list (on the server, a capture shows only TLS records; Caddy's storage holds nothing for the name). Then the Mac. Once both are switched: the old names' site blocks go, the route becomes the wildcard `*.l.<domain>`, and `l.<domain>` gets CAA `issue ";"` and `issuewild ";"`.

**8. Later, optional: certificate log watch (~1.5 h)** (choice E).

| Issue | What | Who | Time |
|---|---|---|---|
| 1 (#199) | Spike: caddy-l4 SNI route, TLS over the tunnel, acme-client with Pebble (all local) | worker | ~2 h |
| 2 | Relay: TLS passthrough by SNI (needs 1) | worker | ~2.5 h |
| 3 | Ledung: TLS on tunnelled streams (needs 1; can run beside 2) | worker | ~2.5 h |
| 4 | Ledung: certificates through ACME TLS-ALPN-01, with the CAA wait, proven with Pebble (needs 3) | worker | ~3.5 h |
| 5 | Server, first slice: caddy-l4 and the relay's pass-through port for one test name (after 2–4 merged) | server manager on Martin's word (files by a worker) | ~45 min |
| 6 | First real ACME run on the test name, staging then production (needs 5) | worker + server manager | ~1 h |
| 7 | Switch the PC's and the Mac's Ledung; then the wildcard route and the "nobody" CAA record | worker + server manager; Martin pairs | ~1.5 h |
| 8 | Certificate log watch (optional) | worker | ~1.5 h |

**About 11–12 hours of worker time, and about 3 hours of server and DNS work** (45 min server, 1 h for the first real run, 1.5 h for the switch). Martin's server manager can do that work on his word, which leaves Martin his yes and pairing the phone. It comes in three sittings: the code (issues 2 and 3 can run as two sessions in parallel after the spike, so one long evening), then the test name, then the switch. That is more than the "~1 evening" relay-home.md guessed: the certificate lifecycle (renewal, offline, rate limits, the CAA lock and its wait) is most of it, and the tunnel part is small.

If time runs short, the order of cuts is: 8, then the Mac in 7. Never skip 6 (the first real certificate on a test name, before a real Ledung depends on it), and never 7 without the CAA records, or end-to-end is on paper only.
