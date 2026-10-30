# Push notifications to the phone — design

Oct 20, 2026 · issue #246 · several linked computers through one switch since Oct 30, 2026 (issue #451, below).

**Done when:** a phone paired with this Ledung switches on push in Settings → Devices; a new Waiting-for-you item
sends one notification naming the computer and the kind of item, never its text; tapping it opens the item; the
phone can switch it off, and revoking the device stops it.

- **Web Push with VAPID, our own small sender, no new dependency.** The VAPID key pair (P-256) is made on first use
  and kept in the data folder's `remote/` (`remoteDir()` in `src/platform/paths.ts`, private to the user), next to
  the relay's keys: it never leaves the computer. Sending is a JWT signed ES256 (RFC 8292) and the payload encrypted
  as `aes128gcm` (RFC 8291), both with `node:crypto`, about 150 lines in `src/server/push.ts`. Picked over the
  `web-push` package because that brings five more packages for two functions Node has built in, and `npm run pack`
  then has nothing extra to bundle. The encryption is tested against RFC 8291's own example (Appendix A).
- **A service worker served by Ledung**, `/sw.js` from `web/public`, scope `/`. It only shows the notification and
  opens the item; it caches nothing and fetches nothing. **The CSP and security headers do not change:**
  `default-src 'self'` already covers a same-origin worker (`worker-src` falls back to it), and the worker makes no
  requests. The Host check, sign-in, Origin check and no-embedding rules stay as they are; `sw.js` is a static file
  like the page's scripts, which need no sign-in.
- **A subscription per paired device**, a new `push_subscriptions` table keyed by the device row (a new MIGRATIONS
  entry): the push endpoint and the browser's two keys. Subscribing again replaces it. Only through the public name
  and only from that device's open page (page key) while it is unlocked, the same as any other change (decision 8 of
  relay.md); locally there is no device and the routes answer 404. Revoking the device deletes it; switching off
  deletes it; a push service answering 404 or 410 (the browser dropped it) deletes it. Sending only goes to
  subscriptions of live devices.
- **The endpoint is checked** so a paired device can't make Ledung post to any address: HTTPS, and a host of a known
  push service (Google `fcm.googleapis.com`, Apple `*.push.apple.com`, Mozilla `*.push.services.mozilla.com`,
  Microsoft `*.notify.windows.com`).
- **Minimal payload**, encrypted end to end (the push service can't read it): `{ computer, kind, item }`, where kind is
  `question` or `permission` (a held board post is Ledung's question to the user, so it is a `question`) and item
  what to open (`q12`, or the session for a permission). Never the question, the command or the session's title.
  The notification reads "<computer> — A question is waiting for you"; the page fetches the item when opened, after
  its usual sign-in.
- **Which items notify:** the ones the page's notifications use (`web/src/notify.ts`): an open question or pending
  permission addressed to the user, not one a manager handles. Each item once, when it first appears; items already
  open when Ledung starts don't notify again after a restart. The relay admin's New computer cards are not in
  those rules and don't notify.
- **iPhone** needs the page added to the Home Screen (iOS 16.4+). The web app manifest is already there
  (`standalone`); Settings says so when the browser has no push (Safari in a tab).
- **Tapping** focuses an open Ledung window on the item, or opens one at `/#/waiting/q/<id>` (a question) or
  `/#/s/<session>` (a permission).

## Several linked computers, one switch (issue #451)

Martin, 2026-10-30, question #496: "a — One switch, through the first computer". A phone that shows several
computers as tabs switches push on once, on the computer serving the page (the first tab), and gets that computer's
items and every linked computer's.

- **Over the link, not a new connection.** When a computer has a new item (the same rules as above, each once), it
  sends its kind and tag, never its text, to every linked computer: `/link/push`, through the relay end to end with
  the link's key, the same channel and rate limit as the Waiting-for-you counts (issue #273). The receiving computer
  checks it (only `question` with `q<n>`, or `permission` with `p<id>`) and pushes it to its own phones. It never sends it on, so an item goes one hop and two linked computers can't pass it back and
  forth; a computer linked only through another one is not reached. A computer that is offline then misses it.
- **What the phone sees:** the notification is titled with that computer's name as its tab on the receiving
  computer shows it. Its tag is `<public name>:<item>`, so it never replaces the receiving computer's own item of the
  same number. Tapping opens `/#/c/<public name>` on the receiving computer: its page shows that computer's tab and
  puts its own address back to its start. Not the item inside it: that would put an address of this page into the
  computer's frame, which loads only that computer's own page (issue #241); its badge shows what waits there.
- **In another computer's tab** the browser gives the frame no notifications and no push, so Settings → Phones and
  Settings → Notifications there say "Pushes for this computer come through the first tab" (or, when it is linked
  with no computer, that it needs linking first) instead of a switch.
- **A phone subscribed on both computers** (each opened as its own page) gets a linked computer's item twice, once
  from each; with the switch only on the first tab's page this does not happen.
