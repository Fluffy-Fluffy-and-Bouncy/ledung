// Ledung's service worker (issue #246, docs/steps/push.md): shows a push notification and opens its item when
// tapped. It caches nothing and fetches nothing. The payload names the computer and the kind of item, never its
// text; the page loads that when it opens, after its usual sign-in.
const WORDS = { question: 'A question is waiting for you', permission: 'A permission prompt is waiting for you' };

// A new version takes over at once, and the open pages with it, so a tap can move them to the item.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch { /* not ours: the plain notification below */ }
  const computer = typeof data.computer === 'string' ? data.computer : 'Ledung';
  // Only a path inside this page: the payload came from Ledung, but nothing else is opened.
  const open = typeof data.open === 'string' && data.open.startsWith('/#/') ? data.open : '/#/waiting';
  // A phone must show something for every push (iOS stops sending otherwise), so there is always a notification.
  event.waitUntil(self.registration.showNotification(computer, {
    body: WORDS[data.kind] ?? 'Something is waiting for you',
    tag: typeof data.item === 'string' ? data.item : undefined,
    icon: '/icon-512.png',
    data: { open },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.open ?? '/#/waiting', self.location.origin).href;
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = pages.find((p) => new URL(p.url).origin === self.location.origin);
    if (page) {
      await page.focus();
      try {
        return await page.navigate(url);
      } catch { /* a page this worker doesn't control: a new window instead */ }
    }
    return self.clients.openWindow(url);
  })());
});
