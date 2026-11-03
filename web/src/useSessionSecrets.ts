// A session's locked secrets (issue #468) as the page knows them: names and lifetimes, never a value. Read
// when shown, and kept current by the live connection's secrets events (secretLock.ts).
import { useCallback, useEffect, useState } from 'react';
import type { SecretInfo } from '../../src/shared/secrets.ts';
import { api } from './api.ts';
import { onSecrets, secretsChanged } from './secretLock.ts';

export function useSessionSecrets(sessionId: string): [SecretInfo[], () => Promise<void>] {
  const [list, setList] = useState<SecretInfo[]>([]);
  const reload = useCallback(async () => {
    const fresh = await api.secrets(sessionId);
    secretsChanged(sessionId, fresh);
  }, [sessionId]);
  useEffect(() => {
    setList([]);
    const off = onSecrets(sessionId, setList);
    reload().catch(() => {});
    return off;
  }, [sessionId, reload]);
  return [list, reload];
}
