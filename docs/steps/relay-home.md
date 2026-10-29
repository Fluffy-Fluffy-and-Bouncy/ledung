# The relay's home: choosing a computer, one Waiting for you — design

Oct 17, 2026 · **Design for decisions 6 and 7 of [relay.md](relay.md). All six choices decided by Martin 2026-10-17 12:24–12:52 (see [Decisions taken](#decisions-taken)). Nothing built.** No domains here: `<domain>` stands for whatever Martin picks, set in config.

## What Martin asked for

> 6\. "Hold off with this. We might want to design a seperate system to decide what computer to connect to. Maybe even merge the "waiting for you" to work for multiple computers at once. Do some more thinking of this for me."
>
> 7\. "This ledung is to be used by all users in the end. But only me for the upcoming week."
>
> (Martin, 2026-10-17 12:01, Decision comment on #160)

So: a **home** on the relay where a signed-in person sees all their Ledungs (PC, Mac, …) and their state, and picks one; ideally **one Waiting for you across all of them**; built for many people, used by one this week.

## The idea that settles most of it

**Each Ledung keeps its own name (its own web origin), and the combined view is put together in the browser, by Ledung's own page, not on the relay.**

- The relay knows **who owns which Ledung** and **whether it is online**. That is all it stores.
- A Ledung's page (served by that Ledung, through its tunnel) asks the relay for the list of its owner's other Ledungs, then connects to each of them directly, exactly as it connects to its own: their live connection and their API, each with that Ledung's own device cookie, its own Origin check and its own passkey. Waiting for you shows all their items, each marked with its computer.
- An answer goes **straight to the Ledung that asked**, through that Ledung's tunnel. The relay never answers anything for anyone, and no Ledung trusts the relay's word about who answered.
- **Martin decided 3a** (decision 3): items from all of a person's Ledungs are read **and answered** in Ledung's own page, which costs the isolation between one person's own Ledungs (below, "What the combined view costs"). Answering in the owning Ledung's own page (3b) would have kept it; it is described below as the alternative not taken.

Why this way: a combined list built **on the relay** means the relay holds question content and acts on answers, so every Ledung would have to trust it. Built **in the page**, the relay only carries bytes, and once end-to-end comes (relay.md, Later) it cannot read them either. The combined view then still works unchanged, because nothing in it depends on the relay reading traffic.

## Identity: who is a person on the relay

The relay needs to know who you are only to show you **your** list and, while TLS ends there, to keep strangers away from Ledungs' sign-in pages. It never decides what you may do inside a Ledung: that stays with each Ledung's paired devices and passkeys (relay.md decision 3).

| | How | For | Against |
|---|---|---|---|
| **A. Passkey account on the relay, invite to join** (recommended) | An invite link (made by the relay's admin) creates an account and registers a passkey; signing in is Face ID / fingerprint. Several passkeys per account (phone, laptop); recovery by a new invite from the admin | Fully self-hosted, nothing external to go down or register; the same gesture Martin already uses for sensitive calls; works for anyone, with or without GitHub | Recovery is by hand (the admin); one more sign-in |
| **B. GitHub login** (OAuth) | "Sign in with GitHub"; the account is the GitHub user id; an allowlist of logins who may use the relay | Team members already have GitHub (the message board uses it); no account recovery to run | An OAuth app to register and its secret on the server; GitHub down → no home (Ledungs still reachable by bookmark); ties the relay to GitHub |
| **C. Both** | A first, B as a second way in | Flexible | Two code paths for tonight's successor |

The relay's **account cookie** is for the relay's own name only, never sent to a Ledung's name, so a Ledung never sees it and the relay's account is no key to any Ledung. The outer gate (below, choice 4) would need a second, **gate-only** value that does reach the Ledungs' names; it is a different cookie with far less power, and the relay strips it before anything goes down a tunnel.

## How the relay knows which Ledungs are whose

Without reading their traffic, through **enrolment**:

1. Signed in at the home, the person presses **Add a computer** and names it ("PC"). The relay makes a one-time code (10 minutes).
2. In that Ledung's Settings → Remote, they paste the code. Ledung exchanges it with the relay, over the tunnel endpoint, for its **tunnel credential** and its **public name**. The relay records `{ledung id, owner, display name, public name, credential hash}`.
3. From then on the tunnel's hello proves which Ledung it is; the relay files it under its owner.

Removing a computer at the home kills its credential and closes its tunnel. A Ledung can also leave by itself (Settings → Remote → Disconnect).

**Status on the home** comes from the tunnel, not from traffic: online or not, since when, and, only if the Ledung's owner turns it on, a few counts the Ledung itself sends on the control channel (questions waiting, permission prompts waiting, sessions running). The counts are what a lock screen would show; no question text goes to the relay.

## Naming: one name per Ledung, not paths

| | One name per Ledung (recommended) | One domain, a path per Ledung |
|---|---|---|
| Example | home at `<domain>`, Ledungs at `<word name>.l.<domain>` (decision 2: `copper7meadow4`) | `<domain>/l/<name>/` |
| Isolation | Each Ledung is its own origin: a fault in one Ledung's page cannot act on another's API, nor across people, **unless** the combined view (choice 3a) deliberately opens it between one person's own Ledungs | All Ledungs, of all people, share one origin: one page's script can call every other Ledung the browser has a cookie for |
| Ledung changes | None: it serves at `/` as today | The page and API must work under a path prefix (every `/api`, `/ws`, asset URL) |
| Certificates | Many names: for many people a wildcard certificate, which needs the DNS provider's API at the proxy. **This week: a few explicit names, no wildcard** | One certificate |
| Combined view | Cross-origin calls to sibling Ledungs: each Ledung allows its siblings' origins (CORS with credentials) | Same origin, simpler, at the cost of isolation |

**The name (decision 2):** two random words of 6–10 letters each, plus two digits placed at random among them (`copper7meadow4`, `4lantern9harbor`): easy to read out and type, unlike a random id, and it says nothing about the person or computer (not `martin-pc`). The relay picks it at enrolment from a curated word list (no offensive or confusable words), checks it is unused, and it is a valid DNS label as it is (lowercase letters and digits, at most 22 characters). The display name ("PC") lives on the relay and in each Ledung.

**Fewer bits than a random id is fine, because the name was never the secret.** With a list of a few thousand words the name has roughly 30–35 bits: guessable by someone who tries hard, unlike a 128-bit id. Nothing rests on that: reaching a Ledung by name gets a stranger the outer gate (decision 4), and behind it Ledung's own device cookie (256-bit) and passkey. A guessed name only tells someone that a Ledung exists there.

All the names sit under one registrable domain, which is what makes a **shared passkey site** possible: a passkey's RP ID may be that domain, so one passkey on the phone can be registered with each of the person's Ledungs. Each Ledung still stores and checks its own copy of the public key.

## Waiting for you across computers

What the page does (decision 3, choice 3a):

1. On load, the page asks the relay home (cross-origin, with the relay's own cookie) for "my Ledungs": id, display name, public name, online.
2. For each other Ledung that is online and **this device is paired with**, it opens that Ledung's live connection (`wss://<its name>/ws`, with `Origin` this page's origin) and gets that Ledung's own page key and its waiting items.
3. Waiting for you lists every item with its computer's name; a computer that is offline or not paired shows as one line ("Mac: not paired on this phone — pair"). Clicking an item that needs more than the card (a session's chat) opens that Ledung's own page.
4. Answering an item sends it to **that** Ledung's API, with that Ledung's device cookie and page key. Sensitive: that Ledung issues the passkey challenge, bound to its own id, the permission id and the decision; the passkey signs it; only that Ledung verifies it. A signature made for the PC means nothing to the Mac, and an approval for one permission cannot approve another.

What each Ledung must allow for 3a: the **origins of its owner's other Ledungs**, learned from the relay (but never trusted further than that: each still needs its own device cookie and passkey), for its API (CORS with credentials, answering only those origins) and its live connection. The cookies already reach siblings: all the names are one site, so `SameSite=Strict` cookies are sent on these calls; the CORS and Origin lists decide who may read and change. Each Ledung's device cookie stays on its own name (no `Domain=` attribute), so one Ledung never sees another's.

**What the combined view costs (choice 3a):**

- **Isolation between one person's Ledungs is given up.** Ledung A's page calls Ledung B's API with B's cookie, reads B's answers and holds B's page key. A bug or a compromise in A's page (or, while TLS ends at the server, a doctored page served through A's name) can then drive B: answer its questions, allow its ordinary calls, and, by tricking the passkey as in relay.md's risks, its sensitive ones. Isolation **between people** stays: no Ledung lists another person's origins.
- **B's passkey check accepts more origins.** relay.md step 5 checks that the assertion's origin is exactly `https://<B's name>`. A passkey prompt made in A's page carries A's origin, so B must accept the set *its own name plus its owner's other Ledungs' names*, from the relay's list (`@simplewebauthn/server` takes a list of expected origins). The challenge still names B, the permission and the decision, so it cannot be carried to another Ledung or another call. The RP ID must be the shared domain (relay.md choice C1), or B's passkey cannot be used from A's page at all.
- **CSP:** each Ledung's `connect-src` must list `wss://` and `https://` for each sibling (today it lists only its own `ws://` names), and its Origin and CORS lists the same set. The list comes from the relay, so a lying relay could add a name of its own: harmless without that name holding B's device cookie and passkey, but one more thing the relay influences.

**The alternative not taken (choice 3b):** A's page shows every computer's waiting items, but an answer opens **B's own page** on that item (a new tab or a switch), where B's page key and passkey work as today. Cost: one hop per answer, and A still reads B's items (B's API allows A's origin for reading only), so confidentiality between one person's Ledungs is shared but **integrity is not**: A cannot change anything on B, B's passkey origin stays exact and B's write Origin list stays `https://<B's name>` alone. It stays possible as a fallback: a Ledung could refuse sibling writes again without changing the page's reading side.

**Pairing once, not per computer:** pairing a phone with each Ledung by hand (a QR per computer) is the simple version. Better, later: the home shows "pair this phone with all my computers", and each Ledung pairs only after its own Settings (or the page on that computer) confirms. Ledungs still never accept a pairing on the relay's say-so.

### What the relay can see, honestly

- **This week (TLS ends at the server):** the relay *could* read everything the page exchanges with every Ledung, the combined view included, because the bytes pass through its proxy in clear. It doesn't parse or store them, but a break-in on the server could. A combined view does not make that worse than one Ledung at a time: it is the same traffic.
- **The home page itself is served by the relay.** If the combined view lived on the home page, a malicious relay could serve it a doctored script. That is why it lives in **Ledung's own page**: once end-to-end is in, every byte of that page comes from the person's own computer.
- **End-to-end needs:** the proxy routes by name without ending TLS (a layer-4 route), each Ledung holds a certificate for its own name (obtained through the tunnel), and the relay's outer gate (below) can no longer see cookies, so strangers can reach a Ledung's sign-in page again (which the 256-bit cookies and the passkey already cover). The relay then sees: who owns which Ledung, online, the counts if turned on, and the timing and size of encrypted traffic.

## The relay's outer gate (this week)

While TLS ends at the server, the relay can also refuse any request to a Ledung's name that does not carry proof of a signed-in relay session **of that Ledung's owner**: strangers then never reach a Ledung at all. How, so that the proof does not become a new thing to steal:

- **A gate-only cookie, not the account session.** `ledung_gate`: random, `HttpOnly`, `Secure`, `SameSite=Lax`, valid 12 hours, tied to the account. It opens the gate and nothing else: it cannot add or remove computers, make invites or read the home.
- **Scoped to the Ledungs' names only.** Its `Domain` is the parent of the Ledung names, `l.<domain>`, so those names sit under a subdomain of their own (`<word name>.l.<domain>`) and the cookie never reaches the server's other public services under `<domain>`.
- **Set from a host under `l.<domain>`, not from the home.** A browser accepts a cookie's `Domain` only if it is the answering host or a parent of it (RFC 6265), so the home (at `<domain>`) cannot set `Domain=l.<domain>`, and `Domain=<domain>` would reach the other services. So after sign-in, or when the gate cookie has run out, the home redirects to `https://gate.l.<domain>/set?code=<one-time code>` (the relay answers that name too; the code is random, valid 60 seconds, used once, tied to the account and the address to return to). That host sets the cookie with `Domain=l.<domain>` and redirects on to the Ledung or back to the home. A Ledung name without a valid gate cookie redirects to the home's sign-in, which comes back the same way. One more DNS name and certificate (`gate.l.<domain>`, or a wildcard under `l.` later).
- **Stripped before the tunnel.** The relay removes `ledung_gate` from the `Cookie` header before a request goes down a Ledung's tunnel, so no Ledung, and no impostor holding a leaked tunnel secret (relay.md threat model), ever receives it.
- Extra protection only: it goes away with end-to-end (the relay can no longer see cookies), and nothing in a Ledung may depend on it.

## What tonight's build (relay.md steps 1–5) must not rule out

| Tonight | Must be so that later … |
|---|---|
| The relay's config lists people → Ledungs, even with one person | … accounts and enrolment replace the config without a new model |
| Each Ledung has its own public name and serves at `/` | … names per Ledung stay; no path prefix ever needed |
| The tunnel's first message is a versioned hello | … status and counts can be added to the same channel |
| Ledung's public name is one of a **list** of allowed origins (Origin check, CSP, passkey origin), not a single value | … sibling origins can be added for choice 3 |
| The passkey's RP ID is the shared parent domain from the start (relay.md choice C1); otherwise every passkey is registered again when it changes | … one passkey per phone serves all of a person's Ledungs, and a passkey prompt in one Ledung's page can work for another (choice 3a) |
| Every passkey challenge contains the Ledung's id, the action and the decision | … a combined view cannot carry an approval to the wrong Ledung |
| Device cookies have no `Domain=` attribute | … one Ledung never sees another's cookie |
| The relay stores no traffic, ever | … end-to-end changes the routing, not the promises |
| Ledung's page talks to "its" Ledung through one module | … that module can talk to several Ledungs |

None of this adds work tonight beyond choosing the shape: an id in the passkey challenge and a list instead of one name.

## Order of building, after tonight

1. **Home, read only:** relay accounts (choice 1), enrolment instead of config, the list of my Ledungs with online state and a link to each. (~1 evening.)
2. **Counts on the home**, opt-in per Ledung. (~2 h.)
3. **Waiting for you across computers** in Ledung's page (decision 3, 3a): sibling list from the relay, per-Ledung live connections, the widened Origin, CORS, CSP and passkey-origin lists in each Ledung, and answers routed to the Ledung that asked. (~1–2 evenings.)
4. **End-to-end** (relay.md, Later). (~1 evening.)
5. **Pair this phone with all my computers.** (~2 h.)
6. Other people: invites, an admin page, limits per person.

## Decisions taken

Martin, in the manager session, each recorded as a Decision comment on #160 (2026-10-17):

1. **How a person signs in to the relay: A, a passkey account on the relay, invite to join.** "Q1:a" (12:29)
2. **Names: A, one name per Ledung under one domain, as two words and two digits.** "Lets do 2a but with inspiration from the [relay of another of Martin's projects]. Two words 6-10letters each with two numbers. Random where the numbers appear amongst the words. Are you with me?" (12:44; the bracket is paraphrased). The format and why its lower entropy is fine are under [Naming](#naming-one-name-per-ledung-not-paths).
3. **Waiting for you across computers: A, read and answer in Ledung's own page**, connecting directly to sibling Ledungs; the relay only carries bytes. "Q3:a" (12:49). Its costs come with it, as written under "What the combined view costs": isolation between one person's own Ledungs is given up, and each Ledung's passkey check, CSP and Origin list accept its siblings' origins. It also settles relay.md's open choice C: the passkey's RP ID must be the shared parent domain (C1), or a passkey prompt in one Ledung's page could not serve another.
4. **The relay's outer gate this week: A, yes**, with the separate 12-hour gate-only cookie, scoped to the Ledung names and stripped before the tunnel. "A" (12:51)
5. **Counts on the home: A, opt-in per Ledung** (a Settings switch, off by default). "A" (12:52)
6. **Pairing a phone with several computers: one QR per computer for now**, "pair with all" later. "I really liked the on qr-code per computer." (12:24)
