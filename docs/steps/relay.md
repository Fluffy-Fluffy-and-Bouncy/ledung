# Reach a running Ledung from anywhere — proposal

Oct 17, 2026 · **Decisions 1–5 and 7 taken 2026-10-17 12:01; decision 6 (names) held for the design in [relay-home.md](relay-home.md), whose six choices Martin decided 12:24–12:52; open choice B decided 12:54 (decision 8); choices A and D still open under [Still open](#still-open) (B and C settled). Nothing built yet** (issue #160). Desk research and reading Ledung's own code. The server was not inspected: the read-only look was refused by the session's permission check, so the server facts here come from the owner's notes (a reverse proxy already serves HTTPS for several subdomains on ports 80/443; 8 GB of memory, mostly spare). No server names, addresses or domains are written here: they go in the config.

**Done when:** with the PC's screen dark and the phone on mobile data, the phone opens `https://<ledung-name>.<domain>`, sees the sessions, Waiting for you and permission prompts of that Ledung, unlocks ordinary changes with one passkey check (decision 8), answers a question, allows an ordinary permission, and allows a **sensitive** one only after a passkey check of its own on the phone; the PC needed no admin rights and no firewall rule; a second Ledung (the Mac) is reachable the same way under its own name; switching the relay off leaves both Ledungs working locally as before.

## What Martin asked for

> "I believe we need to work on a relay that we host on hetzner that makes it so that we can connect to our active ledung sessions safely and from everywhere. I need you to start doing research into this. The goal is to build it tonight!" (Martin, 2026-10-17 09:02, issue #160)

Today the page is reachable only on the PC, or on the local network with `"lan"`, which needs a Windows firewall rule (admin) and the same network. Away from home, only managers are reachable, through Claude's Remote Control.

## What has to keep holding

From `CLAUDE.md` "Rules that exist for a reason" and the code:

1. **Host check** (`Guard.hostAllowed`): a request must name Ledung itself. A relay brings a new name, which must be added explicitly, never a wildcard.
2. **Sign-in cookie** (`ledung_auth`): today it *is* the install's single secret token, valid a year. Whoever holds it is signed in everywhere.
3. **Origin check** on every change and on the live connection: the page's origin becomes `https://<name>` and must be allowed explicitly.
4. **The page key** (#104): sensitive decisions, and words to a manager, need the key of a live page connection. Today that key is handed to anyone who is signed in and opens the live connection. So **the page key does not stop someone who has the cookie**: it stops a script that has only the token from acting without opening a page. Remotely that is not enough (see the threat model).
5. **No embedding**, strict CSP: `connect-src` lists `ws://` origins only; a remote page needs `wss://<name>`.
6. **Never "bypass permissions"; sensitive calls only on Martin's own answer** (brief section 5). Remotely this must mean: not on a stolen phone's say-so and not on the relay's.
7. **Nothing in Ledung trusts the loopback address**: checked, no code reads `remoteAddress` or `X-Forwarded-For`. That matters because a tunnel delivers every remote request from 127.0.0.1. *As built (Martin, 2026-10-17, question #219): the tunnel hands each stream to Ledung's server in-process and marks it, and anything on a marked connection counts as the public name whatever its Host; nothing comes from 127.0.0.1.*

## The options

**(a) Ledung dials out to a relay.** Ledung (or a small program next to it) keeps one outgoing WebSocket open to a relay on the server. The phone opens `https://<name>.<domain>`; the server's reverse proxy hands that to the relay, which passes the bytes down the tunnel to Ledung on 127.0.0.1. Variants: our own code (Node, the `ws` package Ledung already has), or an existing tunnel: **chisel** (reverse tunnel over HTTPS/WebSocket), **frp** (`frps`/`frpc`, HTTP virtual hosts), **rathole** (frp-like, Rust).

**(b) A mesh VPN.** The PC, the Mac and the phone join a private network: **Tailscale with a self-hosted Headscale** on the server as coordinator, or plain **WireGuard** with the server as hub. Nothing is public; the phone reaches Ledung on its mesh address.

**(c) Cloudflare Tunnel + Access** (baseline, not self-hosted). `cloudflared` on the PC dials out to Cloudflare; Cloudflare Access puts a login (passkey, e-mail code, GitHub) in front.

| | (a) own relay | (a) chisel / frp / rathole | (b) Headscale / WireGuard | (c) Cloudflare |
|---|---|---|---|---|
| **What the relay sees** | Everything, if TLS ends at the server's proxy (tonight). Can become end-to-end later (TLS passthrough, see Later) | Everything (TLS ends at the proxy) | Nothing of the traffic (WireGuard is end-to-end). Headscale sees who is in the mesh and could add a node of its own | Everything (Cloudflare ends TLS) |
| **Phone auth** | Ledung's own: a paired-device cookie, plus a passkey for sensitive decisions | Same, all in Ledung; plus the tool's tunnel secret for the PC | Being in the mesh, plus Ledung's sign-in | Cloudflare Access (passkey / GitHub / e-mail code), plus Ledung's sign-in |
| **Host / Origin / CSP / page key** | One configured public name per Ledung, added to Host, Origin, CSP. Page key unchanged; passkey added for remote | Same | Ledung must listen on its mesh address (`"lan"`) and answer to it | Same as (a) |
| **HTTPS on the phone** | Yes, the proxy's certificate | Yes | **No**: plain HTTP on a mesh address (Headscale cannot issue Tailscale's HTTPS certificates). No secure context, so **no passkeys and no notifications** | Yes |
| **Several Ledungs** | One name and one secret per Ledung; the relay maps name → tunnel | One client config per Ledung | Each machine is a mesh node | One tunnel per Ledung |
| **Windows: admin or firewall rule** | **None**: an outgoing connection from Ledung itself | None (a single exe), but **antivirus often flags chisel and frp as hacking tools** | **Admin** to install the client (a service and a network adapter); a firewall rule for Ledung's port on that adapter, unless `tailscale serve` forwards to localhost | None (`cloudflared` runs as a user program) |
| **Relay down** | Remote access only; Ledung locally unaffected; reconnects by itself | Same, but a separate program to keep running | Mesh keeps working peer to peer while the coordinator is down (Tailscale); hub-WireGuard stops | Remote access only |
| **Cost** | €0 (existing server), 2 DNS names | €0 | €0 | €0 tier; the domain must move to Cloudflare's DNS |
| **Tonight** | ~4–5 h in Ledung plus ~1 h relay and server (plan below) | ~1 h to a working tunnel, but Ledung's changes (names, pairing, passkey) are the same work | Blocked on the PC without admin; no passkeys over HTTP | ~1 h, but hands every token and page key to Cloudflare |

### Why not (b)

It is the best on "the server sees nothing", but on this PC it fails the two things that matter tonight: the client needs **admin** to install, and with a self-hosted coordinator the page stays **plain HTTP**, so the phone gets no passkeys, which is the strong check sensitive decisions need. It also means a VPN app on the phone that must be on.

### Why not (c)

Fine as a baseline and quick, but Cloudflare ends TLS: it sees the sign-in cookie and could open the live connection itself. It is the "not self-hosted" option Martin asked to replace, and the domain would have to move its DNS to Cloudflare.

### Why own code over chisel or frp

The tunnel itself is the small part (about 200 lines each side for a byte pipe with stream numbers). Owning it means no extra exe on the PC for antivirus to quarantine, nothing to start by hand (Ledung starts the tunnel and shows its state in Settings), one secret format, and a path to end-to-end later. chisel is a good **fallback** if the own tunnel isn't working by 22:00: Ledung's changes are identical either way.

## Recommendation

**(a), our own relay**, in two layers:

1. **The tunnel.** Ledung dials `wss://<relay>` with its name and secret; the relay (a small Node program in a container on the server) accepts phone connections for `<name>.<domain>` from the existing reverse proxy and pipes their bytes, HTTP and WebSocket alike, through that Ledung's tunnel to `127.0.0.1:<port>`. The relay never parses Ledung's traffic and stores nothing but the list of names and secret hashes.
2. **Ledung decides who may do what, not the relay.**
   - **Paired devices, not the master token.** "Pair a phone" in Settings (on the PC) shows a one-time link and QR code, valid 10 minutes, used once. Opening it on the phone sets a **device cookie** of its own (random, stored hashed with a name, last used, revocable in Settings). Through the public name, only device cookies count; the install token's `/login` is refused there.
   - **Passkey for anything that needs the page key, through the public name.** Allowing or denying a sensitive call, and words to a manager (until decision 9, below, put those under the unlock), need a WebAuthn assertion from a passkey registered on that device, verified by Ledung, with the challenge bound to the request (permission id + decision, or message hash) and used once. Face ID / fingerprint on the phone is the strong check a stolen, unlocked-for-a-moment phone does not pass, and a copied cookie alone cannot produce.
   - Locally nothing changes: `127.0.0.1` and `"lan"` work exactly as today.

### Honest risks

- **The server can read everything tonight.** TLS ends at the server's reverse proxy, so whoever controls the server sees cookies and page traffic and could serve the phone a doctored page. A passkey stops a stolen phone and a copied cookie from approving sensitive calls, and, through the 30-minute unlock (decision 8), from making ordinary changes; it does **not** fully stop a malicious relay, which could show "allow `ls`" while getting the passkey to sign the challenge for a different, sensitive call. The server is Martin's and runs other public services; a break-in there becomes a way to drive the PC. Closing that is the end-to-end step under Later, not tonight's work.
- **Ledung becomes reachable from the internet** (its sign-in page and static files) through the public name. The token and device cookies are 256-bit random; the relay rate-limits and logs, and drops names with no tunnel.
- **Passkey checks are security code.** Decision 4: `@simplewebauthn/server` does them, a new dependency to keep up to date, rather than our own code.
- **A doubled path for sessions' own sensitive prompts**: the phone sees them as today in Waiting for you; the passkey is one more tap per sensitive call while away. Locally there is no extra step.

## Threat model

| Who / what | Gets | Can they approve a sensitive call? |
|---|---|---|
| Someone on the internet | The sign-in page and static files | No: no device cookie |
| A copied device cookie (a leaked browser profile, a log) | **Read only** (decision 8): every session, Waiting for you, the cards. Without decision 8 it would be a lot more, because today a cookie alone can start a session with any prompt, write to any session that is not a manager and allow its ordinary tool calls, shell included (the page key gates only sensitive permissions and words to a manager, `requirePage` in the server); through the public name every change now needs an open unlock window, which only a passkey check opens. **During a window the device opened**, a copy of its cookie gets ordinary changes too, until the window closes (at most 30 minutes) | **No**: needs the passkey, which never leaves the phone's secure hardware |
| A stolen phone, locked | Nothing until unlocked | No: passkey needs Face ID / fingerprint |
| A stolen phone, unlocked | As a copied cookie, until Martin revokes the device in Settings on the PC. **During a window Martin opened** (at most 30 minutes, decision 9), its open page also gets words to a manager: a typed message, a task or an answer that names a merge can have a PR merged without a prompt (mergeOnAnswer) | No, unless they also pass the biometric |
| The relay operator / a break-in on the server, **tonight** | Everything the phone sends and sees; could inject script into the page | Possibly, by tricking Martin into signing the wrong challenge (see risks). End-to-end closes this |
| Same, **after the end-to-end step** | Encrypted bytes, timing, which name is used | No |
| A leaked tunnel secret | Can connect as that Ledung and take over its name: while it holds it, it sees every request the phone sends there (the device cookie, card texts, answers) and serves the phone whatever page it likes. That is **the same position as the relay operator**, for that one name. Limits: the relay refuses a second agent while the first still answers pings (step 1), so a takeover works only while the real Ledung is offline, and every takeover is logged; Settings shows "another Ledung has your name" when its own tunnel is refused. Fix: rotate the secret | **Possibly**, the same way as the relay operator: by getting Martin to sign a challenge for a different call than the one shown. With the stolen device cookie it can also reach the real Ledung later, as in the copied-cookie row |

## Decisions taken

Martin, 2026-10-17 12:01, typed in the manager session and recorded as the Decision comment on #160:

1. "As recommended" — **option (a), our own relay.**
2. "Ok" — **TLS ends at the server for now**; end-to-end later.
3. "As recommend" — **paired devices only through the public name, and a passkey for page-key actions.**
4. "Go with the package" — **`@simplewebauthn/server`** for passkey checks (not own code).
5. "As recommended" — **a `relay/` folder in this repository.**
6. "Hold off with this. We might want to design a seperate system to decide what computer to connect to. Maybe even merge the "waiting for you" to work for multiple computers at once. Do some more thinking of this for me." — **names held, then designed and decided** in [relay-home.md](relay-home.md) (its "Decisions taken").
7. "This ledung is to be used by all users in the end. But only me for the upcoming week." — **the relay is designed for several people, deployed for Martin alone for now.**

Martin, 2026-10-17 12:54, in the manager session, recorded as a Decision comment on #160. It was asked as review finding "Important 1" of PR #164 and answers the question this document calls **open choice B** (what a paired device may do without a passkey), with the unlock window (B3 here, "C" there) at 30 minutes:

8. "C but unlocks 30min" — **a passkey unlock window: one passkey check through the public name lets that device make ordinary changes for 30 minutes; sensitive decisions and manager words still sign each request; a copied cookie alone is read-only.** *Manager words changed by decision 9.*

"Lets start work at this right away."

Martin, 2026-10-18 10:41, Ledung question #268 (issue #192), after Face ID on every message from the phone ("I cant have to unlock with face-id as soon as I'm sending a message. The 30min unlock doesnt seem to work.", 10:00):

9. "c — Unlock covers everything a manager receives, merge words included" — **words to a manager (a typed message, a message to a project's manager, a manager's first message, a new project's task, an answer to a manager's question) need the open page's key and an unlocked device, no signature each.** The cost shown and accepted: "Anyone holding your unlocked phone could have a PR merged for up to 30 minutes." Still signed one by one: sensitive decisions and answers about them, the lockdown-opening project changes and removal, rename, away mode and the unlock.

## Still open

Decisions 1–5 and 7 above answer the proposal's questions 1–5; names (6) are in [relay-home.md](relay-home.md); decision 8 settles B and relay-home.md decision 3 settles C. Open: A and D. B and C stay below with their options, for the record.

**A. FFBuddha:** does his Ledung join this relay (his own account, names, secrets and passkeys), or does he run his own? The relay supports either.
- *Join:* nothing to build beyond decision 7. Cost: Martin's server carries, and while TLS ends there can read, FFBuddha's traffic; Martin is his relay operator in the threat model.
- *His own:* he deploys `relay/` on a server of his. Cost: his evening and his server; two homes, so no combined view across their Ledungs (not wanted anyway).

**B. What a paired device may do without a passkey.** *Settled by decision 8: B3, with a 30-minute window.* Today, through the public name, a device cookie alone can start sessions and allow ordinary tool calls (threat model, copied-cookie row).
- *B1, accept for now:* passkey only for what needs the page key today (decision 3 as written). Cost: a copied device cookie runs code on the PC until it is revoked. No extra work.
- *B2, a passkey for every change through the public name:* starting a session, writing to one, allowing any permission, answering. Cost: Face ID on every tap while away; ~15 min more in step 5 (the same check, on more routes).
- *B3, an unlock window:* a passkey check unlocks the device's changes for 30 minutes (decision 8; 15 minutes as first proposed); reading always works; sensitive calls still need their own passkey each time, and words to a manager did too until decision 9 put them under the unlock. Cost: a copied cookie is read-only without a fresh unlock; one Face ID per half hour; ~30 min more in step 5. A doctored page during an open window gets the same powers as B1.

**C. The passkey's RP ID.** *Settled by relay-home.md decision 3 (combined view in Ledung's own page): C1, the shared parent domain.* A passkey is tied to its RP ID for good: change it later and every device registers again.
- *C1, the shared parent domain from the start* (the domain all Ledung names sit under, relay-home.md "Naming"): one passkey per phone can later serve all of a person's Ledungs. Cost: the domain must be picked tonight, even though the names themselves stay provisional.
- *C2, each Ledung's own public name:* nothing to pick now. Cost: passkeys registered again when the shared domain comes (a minute per device and Ledung).

**D. Phone use before paired devices (step 4).** See the stop point under step 3.
- *D1, no phone use before step 4:* the install token never goes through the server. Cost: nothing usable from the phone until about three hours into the evening.
- *D2, interim sign-in with the install token, then rotate it:* usable after step 3. Cost: the year-long master token passes the server (where TLS ends) and sits in the phone's browser; after step 4 it must be rotated (delete the token file and restart; every local browser signs in again once), and until then any copy of it works everywhere.

## The evening build plan

Ordered so that each step works on its own and the evening can stop after any of them with something usable. Times are estimates for one worker session plus Martin for the server and phone steps.

**0. Server and DNS (Martin, ~20 min).** Names as decided in [relay-home.md](relay-home.md) (decision 2 there): one name for the relay and its home under `<domain>`, and one name per Ledung under a subdomain of their own, `<word name>.l.<domain>`, where the word name is two random words and two digits (`copper7meadow4`), generated now for the PC and the Mac and written into the relay's config (enrolment comes later), plus `gate.l.<domain>` for the outer gate's cookie (relay-home.md, "The relay's outer gate"). DNS for those → the server. Reverse proxy: those three names → the relay container on an internal port (no new open ports; 443 is already open). Generate a secret per Ledung.
*Test:* `https://relay.<domain>/health` answers `ok` with a valid certificate.

**1. Relay (~1 h).** `relay/`: Node, `ws`, one file. Its config lists people and their Ledungs (decision 7: built for several people, with one person in it for now; see relay-home.md, "What tonight must not rule out"). Agents connect to `/agent` with `name` + secret (secrets kept as SHA-256 hashes in its config; a second agent for a name that is live is refused and logged, see the threat model's tunnel-secret row); the first message is a versioned hello, so status can be added to the same channel later; phone connections for `<name>.<domain>` (the proxy passes the Host) become numbered streams over that agent's socket; no agent connected → a plain "This Ledung is offline" page. Limits: frame size, streams per agent, connection attempts per address. Logs connects, disconnects and refusals, never contents.
*Test:* `test/relay.test.ts`: a fake agent and a fake browser through a relay on localhost — HTTP and a WebSocket upgrade come through byte for byte; wrong secret is refused; an unknown name gets the offline page; a second agent with the same name is refused while the first answers pings, and takes over once the first misses them (a dropped connection reconnects within the ping time, about 30 s).

**2. Ledung: the tunnel client (~45 min).** Config `"remote": { "relay": "wss://…", "name": "copper7meadow4", "publicName": "copper7meadow4.l.<domain>", "secret": "…" }` (in the local config, never the repo). Ledung opens the tunnel after it starts listening, pipes each stream to its own `127.0.0.1:<port>` (*as built, #219: hands each stream to its server in-process, marked as the public name's*), reconnects with backoff, and never delays or fails startup when the relay is down. Settings shows "Remote: connected / reconnecting / off".
*Test:* unit test with the relay from step 1: a request through the tunnel reaches a throwaway Ledung; killing the relay leaves the local page working and the client reconnects when it comes back. Loopback on port 4397.

**3. Ledung: the public name in the guards (~30 min).** `publicName` is added to the allowed Hosts, to Origins as `https://<publicName>`, and to CSP `connect-src` as `wss://<publicName>`; cookies set through it get `Secure`. It is never a `"lan"` name, so `"lanSignIn": false` cannot open it.
*Test:* `test/server-security.test.ts` grows cases: the public Host is allowed only when configured; `Origin: http://<publicName>` (not https) is refused; with `"lan"` and `"lanSignIn": false`, the public name still requires sign-in; a wildcard or a lookalike Host is refused.

*Stop point:* steps 0–3 make the page reachable through the public name, but **before step 4 the only way to sign in there is the install token** (`/login?token=`), the year-long master secret, passing a server where TLS ends. Whether the phone is used at this point is open choice D: either the phone waits for step 4 (D1), or it signs in with the token now and the token is rotated after step 4 (D2). Either way, requests through the public name that need the page key are refused until step 5.

**4. Ledung: paired devices (~1 h).** Migration: `devices(id, name, cookie_hash, created_at, last_used_at, revoked_at)`. Settings → "Pair a phone": one-time code (10 min, single use) as a link and QR; `/pair?code=` on the public name sets the device cookie and asks for a device name. Through the public name, `mayUse` accepts only a live device cookie; `/login?token=` is refused there. Settings lists devices with Revoke.
*Test:* pairing code works once and expires; a revoked device is refused at once, including its open live connection (closed on revoke); the install token is refused through the public name and still works locally.

**5. Ledung: passkey for page-key actions (~1.5 h).** With `@simplewebauthn/server` (decision 4). After pairing, the phone registers a passkey (RP ID from the config: the shared parent domain, choice C1, settled by relay-home.md decision 3), stored with the device. `requirePage` through the public name additionally needs an assertion whose challenge Ledung issued for exactly this action (permission id + decision, or the hash of the words to a manager), unused, under two minutes old, origin in the set *its own `https://<publicName>` plus its owner's other Ledungs' names* (relay-home.md decision 3, the combined view; only its own name until the home exists), user verified, signature counter not going backwards. The card says what is being allowed before the passkey prompt.
**The unlock window (decision 8):** through the public name, every other change (starting a session, writing to one, answering a question, allowing an ordinary permission) needs an open window for that device: a passkey assertion on an "unlock" challenge opens it for 30 minutes from the check, kept in Ledung against the device (not in the cookie), shown on the page with the time left and a Lock button. Revoking the device closes it. Reading never needs it. Since decision 9 the window, with the open page's key, also covers words to a manager.
*Test:* the check through the package with a software authenticator made in the test (a real ES256 key); a challenge for permission A cannot allow permission B; a reused or expired challenge is refused; user-verified flag missing → refused; **a device cookie alone is refused for a change and allowed to read; after an unlock the same change is allowed; 30 minutes after the check (a fake clock) it is refused again; during an open window a sensitive call is still refused without its own assertion, and words to a manager go through on the page key alone (decision 9); revoking the device closes the window;** locally, no passkey is asked.

**6. The real thing (Martin, ~20 min).** Release; restart Ledung; pair the phone on mobile data; register the passkey; answer an ordinary question; allow an ordinary permission; allow a sensitive one with Face ID; revoke the phone and see it locked out; stop the relay container and see the local page unaffected and Settings say "reconnecting"; repeat pairing for the Mac's Ledung under its own name.
*Test:* the Done-when list above, ticked one by one.

If the evening runs short, the order of cuts is: 6's Mac part, then 5 (remote stays without sensitive decisions: they wait for the PC), never phone use without 4 unless choice D2 was taken, and never 3 without the security tests.

## Later

- **End-to-end:** the reverse proxy passes TLS through by name instead of ending it (a layer-4 route), and Ledung holds its own certificate for its public name, obtained through the tunnel (ACME TLS-ALPN challenge). Then the server sees only encrypted bytes, and the passkey covers a malicious relay too. Proposal: [relay-e2e.md](relay-e2e.md).
- A relay home page listing the person's Ledungs (with their state), so the phone has one bookmark.
- Browser notifications on the phone (secure context is there once on HTTPS), and later Web Push.
