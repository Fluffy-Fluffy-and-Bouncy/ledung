// What a Settings tab holds between Save presses (issue #366): the saved value, as the server last sent it or as the
// tab saved it, and the value being edited. A new value from the server (another browser, a manager's tool) becomes
// the saved one, and replaces the edited one only while nothing is changed, so typing is never thrown away.
import { useEffect, useState } from 'react';

export interface Edited<T> {
  saved: T;
  value: T;
  set: (value: T) => void;
  /** After a save: what was saved is the saved value and the value. */
  done: (value: T) => void;
  /** Throws the unsaved changes away. */
  discard: () => void;
}

export function useEdited<T>(server: T, changed: (saved: T, value: T) => boolean): Edited<T> {
  const [saved, setSaved] = useState(server);
  const [value, set] = useState(server);
  const key = JSON.stringify(server);
  useEffect(() => {
    setSaved(server);
    set((v) => (changed(saved, v) ? v : server));
  }, [key]);
  return { saved, value, set, done: (v) => { setSaved(v); set(v); }, discard: () => set(saved) };
}
