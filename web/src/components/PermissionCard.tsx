// A permission request waiting for Simon: what the session wants to do, with Allow and Deny.
// Claude's multiple-choice questions (AskUserQuestion) arrive the same way and get a question card.
import { useState } from 'react';
import type { PermissionInfo } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { ToolPreview } from './ToolPreview.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';
import { NOT_AT_PC, STOP_NOTE, UAC_NOTE } from '../../../src/shared/elevation.ts';

export function PermissionCard({ permission, managerTitle }: { permission: PermissionInfo; managerTitle?: string }) {
  if (permission.toolName === 'AskUserQuestion') return <QuestionCard permission={permission} />;
  return <ApprovalCard permission={permission} managerTitle={managerTitle} />;
}

function ApprovalCard({ permission, managerTitle }: { permission: PermissionInfo; managerTitle?: string }) {
  const typing = usePlainTyping();
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (behavior: 'allow' | 'deny', scope: 'once' | 'session' = 'once', denyMessage = message) => {
    setBusy(true);
    setError(null);
    try {
      await api.decide(permission.id, { behavior, scope, message: behavior === 'deny' ? denyMessage : undefined });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="card permission">
      <div className="card-head">
        <strong>Permission: {permission.toolName}</strong>
        {permission.title && <span className="muted"> · {permission.title}</span>}
        {permission.addressedTo !== 'user' && (
          <span className="muted"> · {permission.sensitive ? 'with' : 'for'} manager "{managerTitle ?? 'manager'}"{permission.sensitive ? '' : ' to decide'}</span>
        )}
      </div>
      {permission.sensitive && (
        <p className="sensitive-note">
          <strong>Sensitive</strong>: only you can allow this, once at a time.
          {permission.addressedTo !== 'user' && ' Its manager asks you about it; you can also decide it here.'}
          {' '}<span className="muted">({permission.sensitive})</span>
        </p>
      )}
      {permission.uac && (
        <p className="sensitive-note">
          <strong>Administrator</strong>: {UAC_NOTE} <span className="muted">{STOP_NOTE}</span>
        </p>
      )}
      {permission.reason && <p className="muted">{permission.reason}</p>}
      <ToolPreview toolName={permission.toolName} input={permission.input} />
      {denying && (
        <textarea {...typing}
          className="deny-message"
          placeholder="Optional: tell the session why, or what to do instead"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          autoFocus
        />
      )}
      <div className="actions">
        <button className="allow" disabled={busy} onClick={() => decide('allow')}>Allow once</button>
        {!permission.sensitive && (
          <button disabled={busy} title="Allow this request and its repeats for the rest of this session" onClick={() => decide('allow', 'session')}>
            Allow for this session
          </button>
        )}
        {denying ? (
          <button className="deny" disabled={busy} onClick={() => decide('deny')}>Deny</button>
        ) : (
          <button className="deny" disabled={busy} onClick={() => setDenying(true)}>Deny…</button>
        )}
        {permission.uac && (
          <button className="deny" disabled={busy} title="Deny it, telling the session nobody is at the PC to answer UAC" onClick={() => decide('deny', 'once', NOT_AT_PC)}>
            Deny: not at the PC
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

function QuestionCard({ permission }: { permission: PermissionInfo }) {
  const typing = usePlainTyping();
  const questions = (permission.input.questions ?? []) as Question[];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (q: Question, label: string) => {
    setPicked((p) => {
      const current = p[q.question] ?? [];
      if (!q.multiSelect) return { ...p, [q.question]: [label] };
      return { ...p, [q.question]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] };
    });
    if (!q.multiSelect) setOther((o) => ({ ...o, [q.question]: '' }));
  };

  const answerFor = (q: Question): string => {
    const typed = other[q.question]?.trim();
    const labels = picked[q.question] ?? [];
    return [...labels, ...(typed ? [typed] : [])].join(', ');
  };
  const complete = questions.every((q) => answerFor(q));

  const submit = async (behavior: 'allow' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      const answers = Object.fromEntries(questions.map((q) => [q.question, answerFor(q)]));
      await api.decide(permission.id, behavior === 'allow' ? { behavior, answers } : { behavior, message: 'Simon declined to answer.' });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="card question">
      {questions.map((q) => (
        <fieldset key={q.question}>
          <legend>
            {q.header && <span className="chip">{q.header}</span>} {q.question}
          </legend>
          {q.options.map((o) => {
            const on = (picked[q.question] ?? []).includes(o.label);
            return (
              <button key={o.label} type="button" className={`option${on ? ' on' : ''}`} onClick={() => toggle(q, o.label)}>
                <strong>{o.label}</strong>
                {o.description && <span className="muted"> {o.description}</span>}
              </button>
            );
          })}
          <input {...typing}
            className="other"
            placeholder="Or type your own answer"
            value={other[q.question] ?? ''}
            onChange={(e) => {
              const value = e.target.value;
              setOther((o) => ({ ...o, [q.question]: value }));
              if (!q.multiSelect && value) setPicked((p) => ({ ...p, [q.question]: [] }));
            }}
          />
        </fieldset>
      ))}
      <div className="actions">
        <button className="allow" disabled={busy || !complete} onClick={() => submit('allow')}>Answer</button>
        <button className="deny" disabled={busy} onClick={() => submit('deny')}>Decline</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
