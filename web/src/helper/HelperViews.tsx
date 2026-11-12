// The first start and the Ledung Helper (docs/steps/ledung-helper.md): the Welcome and Claude check screens before
// there is any AI, the step bar over the helper's chat (Ledung keeps the steps), the cards the helper shows in its
// chat, and Settings → Ledung Helper. A card never approves anything: the person's pick goes back as their message,
// and what needs their approval stays Ledung's own approval card in the chat.
import { useEffect, useState, type ReactNode } from 'react';
import type { ProjectInfo } from '../../../src/shared/protocol.ts';
import type { HelperCard } from '../../../src/shared/helper-cards.ts';
import { SETUP_STEPS, stepLine, type HelperInfo, type SetupStepId } from '../../../src/shared/setup.ts';
import { api, type ClaudeCheck } from '../api.ts';
import { FolderBrowser } from '../projects/ProjectViews.tsx';
import { ProblemText, LookedList } from '../components/ClaudeCodeSettings.tsx';
import { CheckInNotice } from '../components/CheckIn.tsx';
import { ShortcutNotice } from '../components/Shortcuts.tsx';
import { useShortcuts } from '../useShortcuts.ts';
import { useCheckIn } from '../useCheckIn.ts';
import { statusLine } from '../checkIn.ts';
import { helperLinkView, myselfView } from './helperNav.ts';
import { usePlainTyping } from '../usePlainTyping.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;

/** What the Welcome and Claude check screens say; the helper takes over after them. */
export function SetupScreens({ helper, run }: { helper: HelperInfo; run: Run }) {
  const [check, setCheck] = useState<ClaudeCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const look = () => run(async () => {
    setChecking(true);
    try {
      setCheck(await api.setupClaude());
    } finally {
      setChecking(false);
    }
  });
  // The check runs by itself when its screen opens.
  useEffect(() => {
    if (helper.setup.phase === 'claude' && !check) void look();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [helper.setup.phase]);
  const leave = <button className="link-button" onClick={() => void run(() => api.setup('leave'))}>Set up by hand instead</button>;
  if (helper.setup.phase === 'welcome') {
    return (
      <div className="setup-screen">
        <div className="setup-card">
          <div className="setup-mark" aria-hidden="true">✦</div>
          <h1>Welcome to Ledung</h1>
          <p>Ledung runs several Claude Code sessions on this computer and shows them in one place: each project gets a <b>manager</b> you talk to, who starts sessions to do the work and asks you when something needs your say.</p>
          <p>First a quick check that Claude Code is ready. Then the <b>Ledung Helper</b>, Ledung's own assistant, sets up your first project with you, one step at a time.</p>
          <div className="setup-actions">
            <button className="primary" onClick={() => void run(() => api.setup('welcome'))}>Get started</button>
            {leave}
          </div>
        </div>
      </div>
    );
  }
  const ok = check && !check.problem && check.signIn === 'in';
  const start = () => run(async () => {
    setStarting(true);
    try {
      await api.setup('claude');
    } finally {
      setStarting(false);
    }
  });
  return (
    <div className="setup-screen">
      <div className="setup-card">
        <div className="setup-steps muted">Before the helper · Claude check</div>
        <h1>Is Claude Code ready?</h1>
        <p className="muted">Ledung runs your own Claude Code, signed in with your own Claude account. The helper is Claude too, so it needs this first.</p>
        <ul className="setup-checklist">
          <li className={check ? (check.problem ? 'bad' : 'good') : ''}>
            <b>Claude Code installed</b>
            {!check ? <span className="muted"> · checking…</span> : check.problem
              ? <div className="setup-help"><ProblemText text={check.problem} />{check.looked.length > 0 && <LookedList looked={check.looked} />}</div>
              : <span className="muted"> · found</span>}
          </li>
          <li className={check && !check.problem ? (check.signIn === 'in' ? 'good' : 'bad') : ''}>
            <b>Signed in</b>
            {!check || check.problem ? <span className="muted"> · {check ? 'after Claude Code is installed' : 'checking…'}</span> : check.signIn === 'in'
              ? <span className="muted"> · yes</span>
              : <div className="setup-help">{(check.help ?? 'Sign in to Claude Code in a terminal: run `claude`, then `/login`.').split('`').map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</div>}
          </li>
        </ul>
        <div className="setup-actions">
          {ok
            ? <button className="primary" disabled={starting} onClick={() => void start()}>{starting ? 'Starting the helper…' : 'Start the Ledung Helper'}</button>
            : <button className="primary" disabled={checking} aria-busy={checking} onClick={() => void look()}>{checking ? 'Checking…' : 'Check again'}</button>}
          {leave}
        </div>
      </div>
    </div>
  );
}

/**
 * Over the helper's chat while it sets up: "Setting up · step N of M: <step>", the steps so far, Do it myself instead
 * (the plain form for that step) and, for a step that is the person's word, Done and Skip; at the end, the hand-over.
 */
export function HelperStepBar({ helper, projects, run, onOpen }: { helper: HelperInfo; projects: ProjectInfo[]; run: Run; onOpen: (id: string) => void }) {
  const v = helper.setup;
  const typing = usePlainTyping();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (v.phase !== 'helper') return null;
  const step = v.current ? SETUP_STEPS.find((s) => s.id === v.current)! : null;
  const project = v.project ? projects.find((p) => p.name === v.project) : undefined;
  const myself = v.current ? myselfView(v.current, v.project) : null;
  /** Steps whose thing Ledung can't see are the person's word: Done says it. */
  const theirWord: SetupStepId[] = ['accounts', 'basics', 'sensitive', 'grant', 'phone'];
  /** Done or Skip in the bar: Ledung marks it, and the helper hears it from the person, so it goes on. */
  const mark = (m: 'done' | 'skipped') => run(async () => {
    const at = step!;
    await api.setupMark(at.id, m);
    if (helper.sessionId) await api.send(helper.sessionId, `${at.label}: ${m === 'done' ? 'done' : 'skip it'}.`);
  });
  if (!v.current) {
    return (
      <div className="helper-steps done">
        <div className="helper-steps-line"><span className="helper-steps-mark">✦</span> Setup done</div>
        <div className="helper-steps-actions">
          {project
            ? <button className="small primary" onClick={() => void run(async () => { await api.setup('finish'); onOpen(project.managerId ?? `p:${project.name}`); })}>Say hello to {project.name}'s manager</button>
            : <button className="small primary" onClick={() => void run(() => api.setup('finish'))}>Finish</button>}
        </div>
      </div>
    );
  }
  return (
    <div className="helper-steps">
      <button className="helper-steps-line" aria-expanded={open} onClick={() => setOpen(!open)} title="Show the steps">
        <span className="helper-steps-mark">✦</span> <span className="helper-steps-text">{stepLine(v)}</span> <span className="helper-steps-caret">{open ? '▴' : '▾'}</span>
      </button>
      <div className="helper-progress" aria-hidden="true"><span style={{ width: `${Math.round(((v.index - 1) / v.total) * 100)}%` }} /></div>
      {open && (
        <ol className="helper-step-list">
          {v.steps.map((s) => (
            <li key={s.id} className={`${s.state}${s.id === v.current ? ' current' : ''}`}>
              <span className="helper-step-state">{s.state === 'done' ? '✓' : s.state === 'skipped' ? '–' : s.id === v.current ? '●' : '○'}</span> {s.label}
            </li>
          ))}
        </ol>
      )}
      <div className="helper-steps-actions">
        {v.current === 'name' ? (
          <form className="helper-name" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(() => api.setupName(name)); }}>
            <input {...typing} value={name} onChange={(e) => setName(e.target.value)} placeholder="Or type your name here" aria-label="Your name" maxLength={40} />
            <button className="small" type="submit" disabled={!name.trim()}>Save</button>
          </form>
        ) : myself && <button className="small" onClick={() => onOpen(myself)}>Do it myself instead</button>}
        {theirWord.includes(v.current) && (v.current === 'accounts' || v.current === 'phone' || v.project) && (
          <button className="small" onClick={() => void mark('done')}>Done</button>
        )}
        {step?.skippable && <button className="small" onClick={() => void mark('skipped')}>Skip</button>}
        <button className="link-button small-link" onClick={() => void run(() => api.setup('leave'))}>Leave setup</button>
      </div>
    </div>
  );
}

/** A card the helper showed in its chat. Its pick is sent as the person's message; once answered it is shown settled. */
export function HelperCardView({ card, answered, onSend, onOpen, projects, run }: {
  card: HelperCard; answered: boolean; onSend: (text: string) => void; onOpen: (id: string) => void; projects: ProjectInfo[]; run: Run;
}) {
  const typing = usePlainTyping();
  const [text, setText] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const wrap = (inner: ReactNode, extra = '') => (
    <div className={`helper-card ${card.kind}${answered ? ' answered' : ''}${extra}`}>
      <div className="helper-card-title">{card.title}</div>
      {inner}
    </div>
  );
  switch (card.kind) {
    case 'choice':
      return wrap(
        <div className="helper-choices">
          {card.options.map((o) => (
            <button key={o.label} className="helper-choice" disabled={answered} onClick={() => onSend(o.label)}>
              <span className="helper-choice-label">{o.label}</span>
              {o.hint && <span className="helper-choice-hint">{o.hint}</span>}
            </button>
          ))}
        </div>,
      );
    case 'text':
      return wrap(answered ? null : (
        <form className="helper-text" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSend(text.trim()); }}>
          <input {...typing} value={text} onChange={(e) => setText(e.target.value)} placeholder={card.placeholder ?? ''} aria-label={card.title} maxLength={200} autoFocus />
          <button className="small primary" type="submit" disabled={!text.trim()}>Send</button>
        </form>
      ));
    case 'folder':
      return wrap(answered ? null : browsing
        ? <FolderBrowser load={api.browse} reloadKey="helper" start={card.start} onPick={(p) => { setBrowsing(false); onSend(`Folder: ${p}`); }} pickLabel="Use this folder" />
        : <button className="small primary" onClick={() => setBrowsing(true)}>Choose a folder</button>);
    case 'link': {
      const view = helperLinkView(card.to, card.project ?? null, projects);
      return wrap(view ? <button className="small primary" onClick={() => onOpen(view)}>Open</button> : <p className="muted">That page isn't there.</p>);
    }
    case 'review':
      return wrap(<button className="small primary" onClick={() => onOpen(`q:${card.question}`)}>Open the review</button>);
    case 'step':
      return wrap(<StepCard step={card.step} answered={answered} onSend={onSend} onOpen={onOpen} run={run} />, ' step');
  }
}

/** The person's own controls for a step: they press them; Ledung sees the shortcuts and the notice answered. */
function StepCard({ step, answered, onSend, onOpen, run }: { step: 'shortcuts' | 'checkin' | 'phone' | 'accounts'; answered: boolean; onSend: (t: string) => void; onOpen: (id: string) => void; run: Run }) {
  const shortcuts = useShortcuts();
  const checkIn = useCheckIn();
  const done = (said: string) => !answered && <button className="small" onClick={() => onSend(said)}>{said}</button>;
  if (step === 'shortcuts') {
    const v = shortcuts.view;
    if (!v) return <p className="muted">Shortcuts are made from the page on the computer Ledung runs on. Open Ledung there, or skip this step.</p>;
    if (!v.asked) return <ShortcutNotice run={run} />;
    return <p className="muted">{v.available ? `Answered: ${v.places.some((p) => p.present) ? 'the shortcuts are there' : 'no shortcuts'}${v.signIn.on ? ', and Ledung starts when you sign in' : ''}. Settings → Update & restart changes it.` : v.reason}{' '}{done('Done with shortcuts')}</p>;
  }
  if (step === 'checkin') {
    const v = checkIn.view;
    if (v?.notice) return <CheckInNotice run={run} />;
    return <p className="muted">{v ? statusLine(v) : 'Answered.'} Settings → About → Usage count changes it. {done('Done with the check-in')}</p>;
  }
  if (step === 'phone') {
    return (
      <div className="helper-step-controls">
        <p className="muted">On your home network: set <code>"lan"</code> in the config file to this computer's address. From anywhere: join a relay, then pair your phone. Opening Ledung to a network is your own setting.</p>
        <button className="small" onClick={() => onOpen('settings:remote')}>Remote & devices</button>
        {done('Done with the phone')}
        {done('Skip the phone for now')}
      </div>
    );
  }
  return (
    <div className="helper-step-controls">
      <button className="small" onClick={() => onOpen('settings:claude')}>Accounts</button>
      {done("This computer's own login is fine")}
      {done('I added an account')}
    </div>
  );
}

/** Settings → Ledung → Ledung Helper: open it, run the setup again, and its model. */
export function HelperSettings({ helper, run, onOpen }: { helper: HelperInfo | null; run: Run; onOpen: (id: string) => void }) {
  if (!helper) return null;
  const go = async (action: () => Promise<HelperInfo>) => {
    const info = await action();
    if (info.sessionId) onOpen(info.sessionId);
  };
  return (
    <>
      <section>
        <h3>Ledung Helper</h3>
        <p className="muted">Ledung's own assistant: it answers questions about Ledung and does Ledung things for you, such as "create a new project called Atlas" or "switch Atlas to Sonnet". It changes Ledung's settings only, always with your approval where something opens up, and never touches a locked project.</p>
        <div className="restart-confirm">
          <button className="small primary" onClick={() => void run(() => go(() => api.openHelper()))}>Ask the Ledung Helper</button>
          <button className="small" onClick={() => void run(() => go(() => api.setup('again')))}>Run setup again</button>
        </div>
      </section>
      <section>
        <h3>Its model</h3>
        <div className="seg" role="radiogroup" aria-label="The helper's model">
          {(['sonnet', 'haiku', 'opus'] as const).map((m) => (
            <button key={m} role="radio" aria-checked={helper.model === m} className={`small${helper.model === m ? ' primary' : ''}`} onClick={() => void run(() => api.setHelperModel(m))}>
              {m === 'sonnet' ? 'Sonnet' : m === 'haiku' ? 'Haiku' : 'Opus'}
            </button>
          ))}
        </div>
        <p className="muted">Sonnet by default: quick and capable enough for settings. From its next start or resume.</p>
      </section>
    </>
  );
}

