# Push notifications to the phone — design

Oct 20, 2026 · issue #246 · one computer at a time; one phone for several linked computers waits on #245's design.

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
