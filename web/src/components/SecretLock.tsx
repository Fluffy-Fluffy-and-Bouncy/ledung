// The message box's locked secrets (issue #468): the 🔑 by a selection, the chips over the box, a chip's
// name and lifetime, the masked field by Send, and the list in the session's ⚙ menu. No value is kept in
// the page once it has gone to Ledung.
import { useEffect, useRef, useState } from 'react';
import { secretNameProblem, SECRET_LIFETIME_LABEL, SECRET_LIFETIMES, suggestSecretName, type SecretInfo, type SecretLifetime } from '../../../src/shared/secrets.ts';
import { api } from '../api.ts';
import { usePlainTyping } from '../usePlainTyping.ts';

/** What the person is told about how far a secret reaches, plainly (the manager's addition 3 on question #1565). */
export const SECRET_LIMITS = [
  'Claude gets only the name; the value is in the environment of the session\'s commands, as $NAME.',
  'A session that was running before this Ledung release gets its secrets from its next start or resume.',
  'Claude Code\'s PowerShell tool and MCP servers see only the secrets the session had when it started (never a "once" one), and keep them until it restarts, even when removed.',
  'While the session can use a secret, its value is in a file only you can read.',
];

/**
 * Where the caret at `index` is drawn in the text box, from its top left corner: measured on a hidden copy of
 * the box with the same text and wrapping, as a textarea has no way to tell.
 */
export function caretPoint(area: HTMLTextAreaElement, index: number): { left: number; top: number } {
  const style = getComputedStyle(area);
  const copy = document.createElement('div');
  const props = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
    'borderBottomWidth', 'borderLeftWidth', 'borderStyle', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'textTransform', 'wordSpacing', 'tabSize'] as const;
  for (const p of props) copy.style[p] = style[p];
  Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden' });
  copy.textContent = area.value.slice(0, index);
  const mark = document.createElement('span');
  mark.textContent = '​';
  copy.appendChild(mark);
  document.body.appendChild(copy);
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3;
  const point = { left: mark.offsetLeft - area.scrollLeft, top: mark.offsetTop - area.scrollTop + line };
  copy.remove();
  return point;
}

/** The 🔑 by a selection: pressing it never takes the focus, so the selection stays for the lock. */
export function SelectionKey({ left, top, onLock }: { left: number; top: number; onLock: () => void }) {
  return (
    <button
      type="button"
      className="secret-key-float"
      style={{ left, top }}
      title="Lock the selected text as a secret: Claude gets its name, never the value"
      aria-label="Lock the selected text as a secret"
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onLock}
    >🔑</button>
  );
}

function LifetimeSelect({ value, onChange, disabled }: { value: SecretLifetime; onChange: (l: SecretLifetime) => void; disabled?: boolean }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as SecretLifetime)} aria-label="How long it lasts">
      {SECRET_LIFETIMES.map((l) => <option key={l} value={l}>{SECRET_LIFETIME_LABEL[l]}</option>)}
    </select>
  );
}

/** The chips over the box, one per secret the text names; a name with no secret any more is struck through. */
export function SecretChips({ known, missing, onOpen }: { known: SecretInfo[]; missing: string[]; onOpen: (id: string) => void }) {
  if (!known.length && !missing.length) return null;
  return (
    <div className="secret-chips" aria-label="Locked secrets in this message">
      {known.map((s) => (
        <button key={s.id} type="button" className="secret-chip" title={`$${s.env} · ${SECRET_LIFETIME_LABEL[s.lifetime]}: change or remove`} onClick={() => onOpen(s.id)}>
          🔑 {s.name}
        </button>
      ))}
      {missing.map((n) => <span key={n} className="secret-chip gone" title="This secret was removed: Claude gets the text as typed">🔑 {n}</span>)}
    </div>
  );
}

/** A locked secret's name and lifetime, right after locking or from its chip. Renaming renames its tokens. */
export function SecretEditor({ sessionId, secret, running, run, onRenamed, onRemoved, onClose }: {
  sessionId: string;
  secret: SecretInfo;
  /** The session's Claude Code runs now: whether reachesNow matters. */
  running: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  onRenamed: (from: string, to: string) => void;
  onRemoved: (name: string) => void;
  onClose: () => void;
}) {
  const typing = usePlainTyping();
  const [name, setName] = useState(secret.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setName(secret.name), [secret.name]);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [secret.id]);
  const problem = name === secret.name ? null : secretNameProblem(name);
  const rename = () => {
    if (name === secret.name || problem) return;
    const from = secret.name;
    void run(async () => {
      await api.editSecret(sessionId, secret.id, { name });
      onRenamed(from, name);
    });
  };
  return (
    <div className="secret-pop" role="dialog" aria-label="Locked secret">
      <div className="secret-pop-head">
        <strong>🔑 Locked</strong>
        <span className="muted">Claude gets <code>${secret.env}</code>, never the value.</span>
      </div>
      <label className="secret-field">
        <span>Name</span>
        <input {...typing}
          ref={input}
          value={name}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(e) => setName(e.target.value.toLowerCase())}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              rename();
            } else if (e.key === 'Escape') onClose();
          }}
        />
      </label>
      {problem && <span className="error">{problem}</span>}
      <label className="secret-field">
        <span>Lasts</span>
        <LifetimeSelect value={secret.lifetime} onChange={(lifetime) => void run(() => api.editSecret(sessionId, secret.id, { lifetime }))} />
      </label>
      {running && !secret.reachesNow && <span className="muted small-note">{SECRET_LIMITS[1]}</span>}
      <div className="secret-pop-buttons">
        <button type="button" onClick={() => void run(async () => {
          await api.removeSecret(sessionId, secret.id);
          onRemoved(secret.name);
        })}>Remove</button>
        <button type="button" className="primary" onClick={() => { rename(); onClose(); }}>Done</button>
      </div>
    </div>
  );
}

/** The 🔑 by Send: a masked field for a value that shouldn't be seen even for a moment. */
export function MaskedSecret({ sessionId, taken, run, onLocked, onClose }: {
  sessionId: string;
  taken: string[];
  run: (action: () => Promise<unknown>) => Promise<void>;
  onLocked: (name: string) => void;
  onClose: () => void;
}) {
  const typing = usePlainTyping();
  const [value, setValue] = useState('');
  const [name, setName] = useState(() => suggestSecretName('', '', taken));
  const [named, setNamed] = useState(false);
  const [lifetime, setLifetime] = useState<SecretLifetime>('session');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const problem = secretNameProblem(name);
  const lock = () => {
    if (!value || problem) return;
    void run(async () => {
      await api.addSecret(sessionId, { name, value, lifetime });
      setValue('');
      onLocked(name);
    });
  };
  return (
    <div className="secret-pop" role="dialog" aria-label="Lock a secret">
      <div className="secret-pop-head">
        <strong>🔑 Lock a secret</strong>
        <span className="muted">Paste or type it; it is never shown, and Claude gets only its name.</span>
      </div>
      <label className="secret-field">
        <span>Secret</span>
        <input
          ref={field}
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (!named) setName(suggestSecretName('', e.target.value, taken));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              lock();
            } else if (e.key === 'Escape') onClose();
          }}
        />
      </label>
      <label className="secret-field">
        <span>Name</span>
        <input {...typing} value={name} spellCheck={false} autoCapitalize="off" onChange={(e) => { setNamed(true); setName(e.target.value.toLowerCase()); }} />
      </label>
      {problem && name && <span className="error">{problem}</span>}
      <label className="secret-field">
        <span>Lasts</span>
        <LifetimeSelect value={lifetime} onChange={setLifetime} />
      </label>
      <div className="secret-pop-buttons">
        <button type="button" onClick={onClose}>Cancel</button>
        <button type="button" className="primary" disabled={!value || !!problem} onClick={lock}>Lock</button>
      </div>
    </div>
  );
}

/** Session ⚙ → Secrets: what this session may use, how long each lives, and Remove. */
export function SessionSecretsMenu({ sessionId, secrets, running, run }: {
  sessionId: string;
  secrets: SecretInfo[];
  running: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <div className="menu-row secrets-row">
      <span className="menu-label">Secrets</span>
      {!secrets.length && <span className="muted">None. Select text in the message box and press 🔑 to lock one.</span>}
      {!!secrets.length && (
        <ul className="secrets-list">
          {secrets.map((s) => (
            <li key={s.id}>
              <span className="secret-name">🔑 {s.name} <code className="muted">${s.env}</code>{running && !s.reachesNow && <span className="muted" title={SECRET_LIMITS[1]}> · from the next start</span>}</span>
              <LifetimeSelect value={s.lifetime} onChange={(lifetime) => void run(() => api.editSecret(sessionId, s.id, { lifetime }))} />
              <button type="button" className="small" onClick={() => void run(() => api.removeSecret(sessionId, s.id))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <details className="secrets-limits">
        <summary className="muted">How far a secret reaches</summary>
        <ul>{SECRET_LIMITS.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
    </div>
  );
}
