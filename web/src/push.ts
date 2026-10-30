// Push notifications to this phone (issue #246, docs/steps/push.md): the service worker, the browser's
// subscription and Ledung's copy of it. The decisions are kept free of the browser so they can be tested.
import { api } from './api.ts';

/**
 * Can this browser get push: 'yes'; 'home-screen' on an iPhone or iPad in a Safari tab, where push only exists for
 * a page added to the Home Screen (iOS 16.4+); 'no' otherwise (an old browser, or not HTTPS).
 */
export function pushSupport(env: { secure: boolean; serviceWorker: boolean; pushManager: boolean; userAgent: string; standalone: boolean }): 'yes' | 'home-screen' | 'no' {
  if (env.secure && env.serviceWorker && env.pushManager) return 'yes';
  if (/iPhone|iPad|iPod/.test(env.userAgent) && !env.standalone) return 'home-screen';
  return 'no';
}

export const browserPushSupport = () => pushSupport({
  secure: window.isSecureContext,
  serviceWorker: 'serviceWorker' in navigator,
  pushManager: 'PushManager' in window,
  userAgent: navigator.userAgent,
  standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches,
});

/** The VAPID public key Ledung sends (base64url) as the bytes pushManager.subscribe takes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** True when a subscription was made with this key; one made with another (the computer's keys made again) can't be used. */
export function sameKey(a: ArrayBuffer | null, key: Uint8Array): boolean {
  if (!a || a.byteLength !== key.length) return false;
  const bytes = new Uint8Array(a);
  return bytes.every((b, i) => b === key[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

/** On: asks for permission (from the click), subscribes with Ledung's key and gives Ledung the subscription. */
export async function pushOn(): Promise<void> {
  const allowed = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (allowed !== 'granted') throw new Error('Notifications are blocked for Ledung here. Allow them in the settings for it, then switch this on again.');
  const { publicKey } = await api.pushState();
  const reg = await registration();
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.pushOn(sub.toJSON());
}

/** Off: Ledung forgets the subscription first, then the browser drops it. */
export async function pushOff(): Promise<void> {
  await api.pushOff();
  const reg = await navigator.serviceWorker.getRegistration('/');
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
}

/** On only when Ledung has this device's subscription and the browser still has one. */
export async function pushIsOn(): Promise<boolean> {
  const { on } = await api.pushState();
  if (!on) return false;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return !!(await reg?.pushManager.getSubscription());
}

/**
 * Settings in another computer's tab (issue #451, Martin's pick on question #496: one switch, through the first
 * computer): the browser gives a frame no notifications, and that computer's items reach the phone through the
 * computer whose page holds the tabs, once the two are linked. `linked`: this computer has a linked computer.
 */
export function framedPushNote(linked: boolean): string {
  return linked
    ? 'Pushes for this computer come through the first tab: on the phone, switch on push notifications in Settings there, under Phones. They say this computer\'s name, and tapping one opens this tab.'
    : 'Pushes for this computer come through the first tab once the two computers are linked (Settings → Linked computers); then, on the phone, switch them on in Settings there, under Phones.';
}
