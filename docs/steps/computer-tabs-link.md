# Computer tabs from the hivemind link, and pairing a computer through it — design

Oct 20, 2026 · **Proposal for #273. Part 2's question decided 20:19 by the manager under its standing grant (question #222): a, a confirm dialog.** It builds on the computer tabs in a frame (#241, PR #244, design in PR #243 `docs/steps/computer-tabs-in-page.md`) and the hivemind link (#245, #250, #254, `docs/steps/manager-link.md`).

## What happened

Martin's first real use, 2026-10-20 20:00–20:12:
- "When I press the "Tubal Cain" the screen turns white." The PC's config had no `computers` list, so the PC answered `frame-ancestors 'none'`. The Mac's list alone isn't enough, because each Ledung decides who may frame it.
- "but I am paired with that computer on this mac, I have it open in an other windows on safari". The Safari web app and the frame each keep their own cookie, so the frame needs its own pairing, and "Pair a computer" makes its code only at the PC's own screen.

## Part 1: tabs and frame permission from the link

- **The computers a Ledung knows** are the config's `computers` plus every linked computer, matched by public name.
- **The config wins on a conflict**, for name, colour and port. Settings → Computers edits still go over both, as today (#240). A linked computer without a config entry takes its name from the link, and its colour is the first one nobody has.
- **Port:** each side tells the other its port in `/link/hello`, kept in `links.json`. Without it, 4317. The port is needed for the local page that may frame (`http://127.0.0.1:<port>`, `http://localhost:<port>`).
- **Live:** linking, unlinking and a hello recompute the tabs, `frame-ancestors`, `frame-src` and the passkey's accepted top origins at once, and open pages get the new list. Unlinking removes the tab and the permission at once.
- **Trust:** a linked computer is already trusted as this computer's own managers are (manager-link decision 4). Letting its pages frame this one is less than that. Nothing about a link reaches a browser: no key, no new route on `/api/`.

## Part 2: pair a computer through the link

**Flow, Mac framing the PC:**
1. In the PC's tab on the Mac's **own screen** (the local page), the PC's "not paired" page shows. The **Mac's** page, around the frame, shows **Pair through the link**. This page knows the frame is a linked computer's, and the PC can't tell reliably who frames it.
2. Martin confirms on the Mac's own screen; see the question. The Mac's server then checks:
   - the request came from its local page, never through its public name (`requireLocal`);
   - it carries that page's key (`requirePage`);
   - the computer is linked;
   - at most one such pairing per computer every 10 minutes.
3. The Mac calls the PC over the link: `POST /link/device-pair`, with the Mac's link key. The PC answers it only on that route (tunnel, TLS, link key, as every `/link/*`). It makes a one-time **computer** pairing code with the normal 10 minutes, kind fixed. It records "asked for by Mac over the link" on the device it then pairs, shows a notice in the PC's Waiting for you ("Mac paired a browser through the link"), and returns the code to the Mac.
4. The Mac's server returns the code to its own page, which points the frame at `https://<PC>/p/<code>`. The frame shows the PC's normal pairing form, and **Pair** there sets the frame's Partitioned cookie, as today.
5. The device is read-only until its passkey is set up in the passkey window (Touch ID) and it logs on (Touch ID), both as today (#244).

**Never startable from a phone or from the PC's public name alone:**
- `/link/device-pair` needs a link key, which no browser ever holds.
- The Mac's start route is local only, so a phone on the Mac's public name can't use it.

**Threat model, what changes:**

| Who | Today | With part 2 |
|---|---|---|
| A phone, or anyone on the PC's or Mac's public name | can't make a pairing code | the same: the start is local only, and the link route needs a link key |
| A copied Mac install-token cookie (local) | full control of the Mac; managers can message the PC's | also: can open a pairing for the PC. **The new device is read-only until its passkey and log-on, which need Touch ID.** It is visible on the PC: the notice, and the device row "through the link from Mac" |
| A leaked link key, or a compromised Mac | messages to the PC's managers; per manager-link.md, forged answers | also: pairing codes for the PC. The same visibility; the rate limit; unlinking stops it |
| A stolen phone | as #244 | unchanged |

The pairing itself gives only a read-only, passkey-less device. Its power still comes from Touch ID in the passkey window and at log on, checked by the PC.

## Decided: how "Pair through the link" is confirmed

**a: a confirm dialog on the Mac's own page.** The manager decided it under its standing grant, question #222, 20:19: "The pairing alone is read-only, every step that gives power takes Touch ID checked by the PC, the start shows on the PC and is rate-limited, and Martin trusts his own Mac's screen like local." The "Touch ID" in #273's text was the manager's wording, not Martin's.

**Residual risk, for Martin at the merge:** someone who already holds the Mac's local session can pair a browser with the PC without Touch ID. That browser gets **read access to all of the PC's sessions, questions and chats**, until the PC removes it. It can change nothing without Touch ID. The PC shows the pairing as a notice and on the device row, and allows at most one per 10 minutes.

The question as asked:

**How is "Pair through the link" confirmed on the Mac's own screen?** The issue says Touch ID. The Mac's own page is `http://127.0.0.1:4317`, and WebAuthn refuses an address as its RP ID, so a passkey can't be used on that page as it is.
- **a (recommended):** a confirm dialog naming the computer, on the Mac's own page with its open-page key, as every page-only action there works today.
  - Touch ID still comes when the new device sets up its passkey and logs on, both checked by the PC.
  - A pairing nobody finishes stays read-only, and the PC shows it.
  - Cost: someone already holding the Mac's local session can start a read-only pairing for the PC without Touch ID. It is shown on the PC, limited by the rate limit, and useless for changes.
- **b:** Touch ID at the start too: the Mac's own page briefly opens `http://localhost:4317/…`, where WebAuthn works with RP ID `localhost`, registers a "this Mac" passkey once, and signs each link pairing.
  - Cost: one more passkey to manage, and about an evening of work.
  - The local screen has never asked for one; that was the rule since step 1.

## Step plan

1. **Part 1** (~2 h): the effective computer list (config, then links), the port in `/link/hello`, the live recompute, and Settings → Computers showing linked computers. Tests: framers from a link; config wins; unlink removes; the port.
2. **Part 2** (~3 h, after the answer): `/link/device-pair`, the Mac's start route and its button, the device row's origin, the notice on the PC. Tests:
   - local only;
   - link key only;
   - the rate limit;
   - a code only for kind computer;
   - nothing from a public name.

   Loopback with two Ledungs and a local relay.

## Built

Both parts on branch `am/fix-273-link-pairing`. The confirm is a bar above the linked computer's frame on this computer's own page: **Pair through the link**, then **Pair** or **Cancel**. The other computer shows each pairing in Waiting for you as "Paired through the link" (OK, or Remove device). Loopback: two Ledungs on 4397/4398 behind a local relay, neither with `"computers"` in its config, driven in Chrome: [computer-tabs-link-loopback/](computer-tabs-link-loopback/) (`link-pairing.ts`, `results.txt`, the shots).

Added the same evening (Martin, 20:22 and 20:27, through the manager): each linked computer's tab shows its Waiting-for-you count, exchanged over the link (`/link/waiting`, a number only: sent on a change, and every 30 s so an offline computer loses its badge); and the passkey window names the reason a passkey wasn't made, and says before trying when this computer has no platform authenticator.
