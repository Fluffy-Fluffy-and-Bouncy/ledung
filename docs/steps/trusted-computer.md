# Trusted computer: act on your other linked computers without a passkey — design

Nov 13, 2026 · **Decided: option a, all five choices as recommended, "with a key on the tab"** (Martin, 09:57, Ledung question #890: "a — Design a, with a key on the tab"). Built on branch `agent/fix-313-trusted-computer`; see *As built* at the end. Builds on the computer tabs in a frame (#241, [computer-tabs-in-page.md](computer-tabs-in-page.md)), the hivemind link and pairing through it (#245, #273, [computer-tabs-link.md](computer-tabs-link.md)), and the passkey rules through the public name ([relay.md](relay.md) decisions 3, 8 and 9; #192).

Why: "For the computers in the hivemind - I think I want to be able to act on my stationary computers without using a passkey. I will soon have a headless mac running and I dont have windows hello on my windows PC. Could that be possible?" (Martin, 2026-11-13 09:33). Question #889: "b — File a "trusted computer" card", cost shown: "A weaker lock: an unlocked trusted computer can act on all of them."

Words used here: **A** is the computer you sit at (its own local page, `http://127.0.0.1:4317`). **B** is the other linked computer, shown in a tab on A's page, in a frame that loads B's public name. The frame's browser is a *computer* device on B, paired through the link (#273).

## How it works today

| From where | What it may do on B | What it takes |
|---|---|---|
| B's own page (B's screen, or the local network with `"lan"`) | everything | nothing: no passkey locally |
| A's tab for B (a *computer* device on B, through B's public name) | look | the device cookie |
| | ordinary changes: start or write to a session, allow an ordinary prompt, answer a question, words to a manager | **log on** once with the passkey (Touch ID / Windows Hello), checked by B; lasts until log out, revoke or 14 days unused |
| | deciding a sensitive prompt or answering a question about one, `!` commands, away mode, rename, the lockdown-opening project changes and project removal | **one passkey signature per request**, logged on or not (`requirePage` / `requireSignedPage`) |
| | device and link management, Settings → Phones / Computers / Linked computers | refused: only on B's own screen (`requireLocal`) |
| A phone (a *phone* device) | the same as the tab, with a 30-minute unlock instead of a log-on | as above |
| A browser with no passkey | look only | `NO_PASSKEY_LOCKED` |

So a PC with no Windows Hello, or a headless Mac, can only **look** at its siblings from a tab, and its siblings' tabs on it can only look too unless the computer you sit at has a passkey.

## The idea in one paragraph

B lets A's **own screen** stand in for the passkey. Where B would ask the frame for a passkey signature over a challenge, the frame instead hands the challenge to the page around it, A's local page; A's server checks that the request came from its own local page (`requireLocal` and the open-page key, as every Settings button there) and passes the challenge to B over the link, with the link key. B accepts it in place of a passkey signature only if B has marked A as trusted, the challenge is open and unused, and the challenge belongs to the frame device that was paired through the link from A. Nothing else about the passkey rules changes: each signed call is still bound to its exact request, used once, within two minutes; the prompt still shows and the person still clicks Allow.

## Choice 1: what makes a computer trusted, and where it is set

- **1a (recommended): on B, the computer being acted on, per linked computer: "Trust A's own screen".** B is the one loosening its rules, so B says so. Set in B's Settings → Linked computers, on B's own screen, **or from a phone with that phone's passkey signature** (one Face ID), so a headless Mac can be set from the phone once. Trust is one-way: B trusting A does not make A trust B; Martin ticks it on each computer he wants to act on.
  - Cost: one setting per computer pair; for a headless Mac, one phone signature or one screen-sharing visit.
- **1b: on A, the trusted computer only; B takes A's word over the link.** One switch on A covers all its linked computers.
  - Cost: whoever holds A's link key (a compromised A, a leaked `links.json`) can make itself trusted everywhere and then decide sensitive prompts on every linked computer. Today a leaked link key reaches managers and read-only pairings, not sensitive prompts.
- **1c: both: A asks, B confirms.** Cost: the same confirm on B as 1a, plus a request step on A; more to build (~1 h more), little more safety than 1a.

## Choice 2: what trust covers

- **2a (recommended): everything a passkey does from a tab, except lockdown-opening project changes and project removal.** Log on, ordinary changes, words to a manager, deciding sensitive prompts and answering questions about them, `!` commands, away mode, rename. The lockdown-opening changes (level, gate loosening, taking a sensitive pattern out) and removal still take a passkey signature, or B's own screen: they turn off the safety net itself, and are rare.
  - Cost: anyone at an unlocked A can decide sensitive prompts on B (merge, push, production), run `!` commands there and switch away mode. The prompt still reaches the person (repo `CLAUDE.md`, "Never offer bypass permissions"); only the Touch ID step is gone.
- **2b: everything, lockdown included.** Cost: as 2a, plus an unlocked A can open B's lockdown and remove projects with no second factor anywhere.
- **2c: ordinary changes and manager words only.** Sensitive prompts, `!`, away mode and lockdown keep their passkey. Cost: the Windows PC and the headless Mac still can't decide a sensitive prompt on a sibling; Martin's question is only half answered.

Never covered, whatever is chosen: device, passkey, link and trust management on B (still B's screen only, or a phone's signature for trust under 1a), and phones (they keep the passkey as today; out of scope in #313).

## Choice 3: how a request proves it comes from A's own local page

- **3a (recommended): a vouch over the link, per request.** The frame asks B for the challenge as today; instead of `navigator.credentials.get` it posts the challenge to its parent window. A's page accepts it only from that frame's window and origin (B's public name), and calls A's `POST /api/link-vouch` with the challenge. A's server requires its local page (`requireLocal` plus the open-page key, so not through A's public name, not a script with A's token alone), rate-limits, and calls B's `/link/vouch` with A's link key. B checks: the caller is linked and trusted, the challenge is open, unused and under two minutes old, and its device is a *computer* paired through the link from that same linked computer. The challenge is then marked vouched, and the frame sends its request as it would with a signature.
  - What it stops: someone with only B's relay address (no link key); a copied frame cookie used from elsewhere (it needs A's local page to vouch); a phone or browser on A's public name (`requireLocal`); a phone on B (never paired through the link).
  - What it does not stop: anyone at A's unlocked screen, malware on A, or a stolen A's link key together with the frame's cookie. That is the cost Martin accepted.
  - Cost: two new routes (one local on A, one link route on B), a parent-frame message, and the paired-through-link device must remember the link's id (a migration: today it keeps the computer's name only).
- **3b: the device cookie alone, when the device was paired through the link from a trusted computer.** No vouch; B treats that device as always logged on and signed. Cost: a copy of the frame's cookie (a browser profile, a log, a backup) acts on B with full power, from anywhere, until its daily renewal makes the copy fail; much weaker than 3a, but about an hour less work.
- **3c: a key made in the frame (WebCrypto, not extractable) registered once at pairing, signing each challenge.** Works without A's server. Cost: proves the browser profile, not A's local page: anything that runs in that profile, or a copy of the whole profile, signs as well; and it needs its own enrolment step.

## Choice 4: whether trust ends

- **4a (recommended): it holds until removed:** untrusted on B, the link unlinked, or the frame's device removed on B. The device's 14-days-unused log-off stays, and logging on again is a vouch with no Touch ID.
  - Cost: it relies on A's own screen lock. Ledung can't see a computer's screen lock from a web page (the browser's idle detection is Chrome only and behind a permission), so a stolen, unlocked A keeps its power until Martin removes the trust on B (from a phone with its passkey under 1a).
- **4b: a time limit, renewed from B (e.g. 30 days).** Cost: a monthly renewal from B's screen or a phone's passkey; little extra safety, since A's own lock is what matters day to day.
- **4c: only while A's own page is open, per vouch:** that is already true under 3a; it is not a separate choice there.

## Choice 5: Settings, and what the other computers show

- **On B, Settings → Linked computers**, each linked computer's row gains **Trust its own screen** (a checkbox with a confirm that states the cost). Trusted, the row says "Trusted · its own screen acts here without a passkey · since <date>", with **Remove trust**. Removing it takes effect at once: the next request from A's tab asks for the passkey (or only looks, on a computer with none).
- **On A, Settings → Linked computers**, a linked computer that trusts A shows "Trusts this computer's screen", exchanged in the link's hello (no key, no rights).
- **In A's tab for B**, the bar above the frame says "Trusted by B: changes from this screen need no passkey there." The passkey dialog does not open; the request goes through after the vouch, and the card says what was done. From an untrusted computer or a phone, the passkey is asked as today.
- **On B, Waiting for you** gets a notice each time trust is set or removed from a phone (not from B's own screen, where the person did it), so a change from elsewhere is never unseen.

Mockups, dark mode: [trusted-computer/settings.png](trusted-computer/settings.png) (B's Settings → Linked computers, one linked computer trusted, one not), [trusted-computer/tab.png](trusted-computer/tab.png) (A's tab for B, a sensitive prompt allowed with no passkey dialog, the trusted bar above). The HTML they are rendered from is next to them.

## Security cost, plainly

With 1a, 2a, 3a and 4a: **anyone at your unlocked trusted computer, or anything running on it, can act on every computer that trusts it — merges and sensitive prompts included — with no Touch ID, until you remove the trust.** A copied cookie alone, someone with only a relay address, or a phone on its own gains nothing new. Lockdown can't be opened that way. The prompts themselves still reach you.

## What is tested (with the build)

`test/server-security.test.ts` grows cases for the new path: the vouch from a trusted linked computer allows a signed call and a log-on; refused when B does not trust A, for a challenge of another device, for a device paired from another computer or a phone, for a used or expired challenge, without the link key; `/api/link-vouch` refused through the public name and without the open-page key; a lockdown-opening change still needs a passkey with trust; removing trust refuses the next request. Plus a loopback with two throwaway Ledungs and a local relay, as #273's.

## Step plan (after the answer)

1. Store: a `trusted_links` table (link id, since, set from), the link id on devices paired through the link (new migrations).
2. B: `/link/vouch`, the vouched challenge accepted in `verifySigned` and as a log-on, the exclusions of choice 2, Settings routes to set and remove trust (local, or a phone's signature).
3. A: `/api/link-vouch` (local, page key, rate-limited), the trust state in the link hello.
4. Page: the frame's parent message instead of the passkey dialog when B says it is trusted; the parent's handler; Settings rows; the tab bar line.
5. Tests, loopback, `docs/decisions.md`, `CHANGELOG.md`.

About 3–4 h of session time for 1a/2a/3a/4a, then review.

## As built

- 1a, 2a, 3a and 4a as above. Not covered by a vouch (2a): opening a locked project up, loosening the sensitive gate (a new project's grant, unasked tools, a sensitive pattern taken out, also for chats) and removing a locked project.
- **"With a key on the tab"**, read as a key mark: a 🔑 after the computer's name on its tab, with the tooltip "<name> trusts this computer's screen: changes from here need no passkey there". The bar above the frame in mockup 2 was not built; the key says it. If "a key on the tab" meant something else, that is a change on top.
- A phone sees each link's name and trust only (`GET /api/link-trust`), to set it with its passkey; the full list stays on the computer itself.
- The notice in Waiting for you when trust is set from a phone (choice 5, last bullet) was not built: a follow-up if wanted.
- Removing trust, and unlinking, log the frame off at once.
- A tab paired before this change has no link id on its device row; it counts by the link's name, when only one link has that name.
