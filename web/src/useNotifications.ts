// Browser notifications for questions and permission prompts addressed to the user (Web Notification API,
// no service worker, no push). Opt-in per browser; display only.
import { useEffect, useRef, useState } from 'react';
import type { PermissionInfo, QuestionInfo, SessionInfo, UsageStopInfo } from '../../src/shared/protocol.ts';
import { planNotifications, stopItems, waitingItems } from './notify.ts';

/** Notifications work only in a secure context (this computer at 127.0.0.1) where the API exists. */
const notificationsPossible = (): boolean => window.isSecureContext && 'Notification' in window;

const KEY = 'ledung.notify';

const stored = (): boolean => {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
};

export function useNotifications(args: {
  loaded: boolean;
  questions: QuestionInfo[];
  permissions: PermissionInfo[];
  sessions: SessionInfo[];
  usageStops: UsageStopInfo[];
  onOpenSession: (id: string) => void;
}) {
  const possible = notificationsPossible();
  const [wanted, setWanted] = useState(stored);
  const [permission, setPermission] = useState<NotificationPermission>(possible ? Notification.permission : 'default');
  const on = possible && wanted && permission === 'granted';

  const previous = useRef<ReadonlySet<string> | null>(null);
  const shown = useRef(new Map<string, Notification>());
  const openRef = useRef(args.onOpenSession);
  openRef.current = args.onOpenSession;

  useEffect(() => {
    // Until the first full list arrives, the lists are empty and nothing may count as "closed".
    if (!args.loaded) return;
    const titleOf = (id: string) => args.sessions.find((s) => s.id === id)?.title ?? 'a session';
    const plan = planNotifications(previous.current, [...waitingItems(args.questions, args.permissions, titleOf), ...stopItems(args.usageStops)]);
    previous.current = plan.open;
    for (const id of plan.close) {
      shown.current.get(id)?.close();
      shown.current.delete(id);
    }
    if (!on || !(document.hidden || !document.hasFocus())) return;
    for (const item of plan.show) {
      try {
        const n = new Notification(item.title, { body: item.body, tag: item.id });
        n.onclick = () => {
          window.focus();
          openRef.current(item.sessionId);
          n.close();
        };
        n.onclose = () => { if (shown.current.get(item.id) === n) shown.current.delete(item.id); };
        shown.current.set(item.id, n);
      } catch {
        // Some browsers refuse the constructor (for example on a phone); nothing to do.
      }
    }
  }, [args.loaded, args.questions, args.permissions, args.sessions, args.usageStops, on]);

  const set = async (value: boolean) => {
    if (!value) {
      setWanted(false);
      try { localStorage.setItem(KEY, '0'); } catch { /* kept for this visit only */ }
      return;
    }
    // Must be asked from the click itself.
    const result = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    setPermission(result);
    const ok = result === 'granted';
    setWanted(ok);
    try { localStorage.setItem(KEY, ok ? '1' : '0'); } catch { /* kept for this visit only */ }
  };

  return { possible, on, denied: possible && permission === 'denied', set };
}
