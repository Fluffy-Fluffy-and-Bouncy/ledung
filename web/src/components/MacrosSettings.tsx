// Settings → Ledung → Macros (issue #410, as mocked and passed by Martin in Ledung question #425): the list in chip
// order, drag to reorder, and the form to add or edit one: name, text, insert or send, global or one project, a chip
// and a keybind each on its own switch, with what stands in a keybind's way.
import { useState } from 'react';
import { CHATS, projectLabel, type ProjectInfo } from '../../../src/shared/protocol.ts';
import { freeKeys, keyLabel, keyOf, keyProblem, macrosProblem, moved, PLACEHOLDERS, type Macro } from '../../../src/shared/macros.ts';
import { api } from '../api.ts';
import { onMac } from './MacroChips.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';

const newId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** A macro kept for a project Ledung no longer has: its chip never shows, so the list says so (code review of #416). */
const gone = (project: string | null, projects: ProjectInfo[]) => project !== null && project !== CHATS && !projects.some((p) => p.name === project);
const scopeLabel = (project: string | null, projects: ProjectInfo[]) =>
  project === null ? 'Global' : `${projectLabel(project)}${gone(project, projects) ? ' (removed)' : ''}`;

export function MacrosSettings(props: { macros: Macro[]; projects: ProjectInfo[]; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const [draft, setDraft] = useState<Macro | null>(null);
  const [dragged, setDragged] = useState<number | null>(null);
  const mac = onMac();
  const save = (list: Macro[]) => props.run(() => api.setMacros(list));
  const editing = draft && props.macros.some((m) => m.id === draft.id) ? draft.id : null;
  return (
    <section>
      <div className="settings-h"><h3>Macros</h3></div>
      <p className="muted">Text you send often, as a chip in a session's info bar, a keybind, or both. Kept by Ledung, so your phone and other browsers have them too.</p>
      {props.macros.length > 0 && (
        <ul className="macro-list">
          {props.macros.map((m, i) => (
            <li key={m.id} className={`${m.id === editing ? 'on' : ''}${dragged === i ? ' dragged' : ''}`}
              draggable onDragStart={() => setDragged(i)} onDragEnd={() => setDragged(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (dragged !== null && dragged !== i) void save(moved(props.macros, dragged, i)); setDragged(null); }}>
              {m.chip
                ? <span className="board-chip macro-chip static">{m.name}{m.send && <span className="macro-send"> ↵</span>}</span>
                : <span className="macro-keyonly" title="No chip: this one is on its keybind only">{m.name}{m.send && <span className="macro-send"> ↵</span>} <span className="muted">· keybind only</span></span>}
              <span className="mono macro-text" title={m.text}>{m.text}</span>
              <span className="muted macro-what">{m.send ? 'Sends' : 'Inserts'}</span>
              {m.key ? <kbd>{keyLabel(m.key, mac)}</kbd> : <span className="muted macro-nokey">no key</span>}
              <span className="chip macro-scope" title={scopeLabel(m.project, props.projects)}>{scopeLabel(m.project, props.projects)}</span>
              <span className="macro-move" title="Drag to reorder" aria-hidden>⋮⋮</span>
              <span className="macro-row-buttons">
                {i > 0 && <button className="small macro-up" title="Move up" aria-label={`Move ${m.name} up`} onClick={() => void save(moved(props.macros, i, i - 1))}>↑</button>}
                <button className="small" onClick={() => setDraft({ ...m })}>Edit</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {draft
        ? <MacroForm key={draft.id} draft={draft} macros={props.macros} projects={props.projects} mac={mac} isNew={!editing}
          onCancel={() => setDraft(null)}
          onSave={async (m) => {
            const list = editing ? props.macros.map((x) => (x.id === m.id ? m : x)) : [...props.macros, m];
            await save(list);
            setDraft(null);
          }}
          onDelete={editing ? async () => { await save(props.macros.filter((x) => x.id !== draft.id)); setDraft(null); } : undefined} />
        : <button className="primary" onClick={() => setDraft({ id: newId(), name: '', text: '', send: false, key: null, chip: true, project: null })}>Add macro</button>}
    </section>
  );
}

function MacroForm(props: { draft: Macro; macros: Macro[]; projects: ProjectInfo[]; mac: boolean; isNew: boolean; onCancel: () => void; onSave: (m: Macro) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [m, setM] = useState<Macro>(props.draft);
  const [keyOn, setKeyOn] = useState(props.draft.key !== null);
  const [recording, setRecording] = useState(false);
  const typing = usePlainTyping();
  const set = (patch: Partial<Macro>) => setM((x) => ({ ...x, ...patch }));
  const key = keyOn ? m.key : null;
  const problem = key ? keyProblem(key, props.macros, m.id) : null;
  const result: Macro = { ...m, key };
  const listProblem = macrosProblem([result]);
  const free = freeKeys(props.macros, m.id);
  const blocked = !m.name.trim() || !m.text.trim() || (keyOn && !m.key) || (!!problem && 'refused' in problem) || !!listProblem;
  return (
    <div className="form macro-form">
      <h4>{props.isNew ? 'New macro' : `Edit “${props.draft.name}”`}</h4>
      <label>Name<input {...typing} value={m.name} maxLength={40} placeholder="Run checks" onChange={(e) => set({ name: e.target.value })} /></label>
      <label>Text
        <textarea {...typing} rows={3} value={m.text} placeholder="Run the checks and tell me what fails." onChange={(e) => set({ text: e.target.value })} />
        <span className="muted macro-hint">Placeholders: {PLACEHOLDERS.map((p) => <code key={p}>{`{${p}}`} </code>)}filled from the session. One it has no value for is not sent: the text goes into the message box instead.</span>
      </label>
      <div className="field">
        <span>When used</span>
        <span className="segmented macro-seg">
          <button className={`small${m.send ? '' : ' on'}`} aria-pressed={!m.send} onClick={() => set({ send: false })}>Put it in the message box</button>
          <button className={`small${m.send ? ' on' : ''}`} aria-pressed={m.send} onClick={() => set({ send: true })}>Send it at once</button>
        </span>
        <span className="muted macro-hint">Shift+click a chip for the other one. A text starting with ! always goes into the box.</span>
      </div>
      <label>Where
        <select value={m.project ?? ''} onChange={(e) => set({ project: e.target.value || null })}>
          <option value="">Global (every project)</option>
          {props.projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          {gone(props.draft.project, props.projects) && <option value={props.draft.project!}>{scopeLabel(props.draft.project, props.projects)}</option>}
          <option value={CHATS}>Chats</option>
        </select>
      </label>
      <label className="toggle macro-switch"><input type="checkbox" checked={m.chip} onChange={(e) => set({ chip: e.target.checked })} /> Show as a chip in the info bar</label>
      <label className="toggle macro-switch"><input type="checkbox" checked={keyOn} onChange={(e) => { setKeyOn(e.target.checked); if (e.target.checked && !m.key) set({ key: free[0] ?? null }); }} /> Keybind</label>
      {keyOn && (
        <div className="macro-sub">
          <span className="macro-keyrow">
            <input {...typing} className={`mono macro-keyin${problem && 'refused' in problem ? ' bad' : ''}`} readOnly aria-label="Keybind"
              value={recording ? 'Press the keys…' : m.key ? keyLabel(m.key, props.mac) : ''}
              onFocus={() => setRecording(true)} onBlur={() => setRecording(false)}
              onKeyDown={(e) => {
                if (e.key === 'Tab' || e.key === 'Escape') return;
                e.preventDefault();
                const k = keyOf(e.nativeEvent);
                if (k) { set({ key: k }); (e.target as HTMLInputElement).blur(); }
              }} />
            <span className="muted macro-hint">{recording ? 'Ctrl, Alt or Cmd with a letter or a digit' : 'Click the box, then press the keys.'}</span>
          </span>
          {problem && 'refused' in problem && <span className="macro-conflict" role="alert">{problem.refused}</span>}
          {problem && 'warning' in problem && <span className="macro-warning">{problem.warning}</span>}
          {problem && free.length > 0 && (
            <span className="macro-hint">Free: {free.map((k) => <button key={k} className="link macro-free" onClick={() => set({ key: k })}><kbd>{keyLabel(k, props.mac)}</kbd></button>)}</span>
          )}
          {!problem && <span className="muted macro-hint">Works in the message box too. A phone has no keys: there it is in the info bar's + menu.</span>}
        </div>
      )}
      {!m.chip && !keyOn && <span className="macro-conflict">With neither a chip nor a keybind nothing could use it.</span>}
      <div className="macro-keyrow">
        <button className="primary" disabled={blocked} onClick={() => void props.onSave(result)}>Save</button>
        <button onClick={props.onCancel}>Cancel</button>
        {props.onDelete && <button className="deny macro-delete" onClick={() => void props.onDelete!()}>Delete</button>}
      </div>
    </div>
  );
}
