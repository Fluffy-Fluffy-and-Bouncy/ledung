// A session's name, typed in place (issue #223): from its sidebar row (double-click) or the ✎ in its header.
// Enter saves, Escape or leaving the field cancels; an empty name is not sent (the server refuses one too).
import { useState } from 'react';
import { usePlainTyping } from '../usePlainTyping.ts';

/** As long as the server takes (MAX_SESSION_NAME). */
const MAX = 80;

export function NameEditor({ value, onSave, onDone, label }: { value: string; onSave: (name: string) => Promise<void>; onDone: () => void; label: string }) {
  const typing = usePlainTyping();
  const [text, setText] = useState(value);
  const name = text.replace(/\s+/g, ' ').trim();
  return (
    <input
      {...typing}
      className="name-editor"
      aria-label={label}
      autoFocus
      maxLength={MAX}
      value={text}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={onDone}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onDone();
        else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (!name) return;
          if (name === value) onDone();
          else void onSave(name).then(onDone);
        }
      }}
    />
  );
}
