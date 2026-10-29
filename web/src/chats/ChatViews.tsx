// Chats in the page (issue #211): New chat, which asks for a folder and optionally a model, profile and
// permission mode and nothing about a project; and the chats' tab in Settings (#366), with their name colour (#222) and
// own sensitive list.
import { Fragment, useEffect, useState } from 'react';
import { PERMISSION_MODES, type ChatsInfo, type PermissionMode } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { FolderBrowser, SensitiveList } from '../projects/ProjectViews.tsx';
import { ChatsColourPicker } from '../components/ProjectName.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';
import { SaveBar, SettingsSplit, Where, useNarrow } from '../components/SettingsFrame.tsx';
import { NARROW_QUERY } from '../sidebarSize.ts';
import { CHATS_GROUPS, tabGroupOf, tabGroupView, tabView } from '../settingsGroups.ts';
import { useEdited } from '../useEdited.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;

const MODE_LABEL: Record<PermissionMode, string> = { default: 'Ask', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan' };

export function NewChatView({ chats, profiles, run, onStarted }: { chats: ChatsInfo | null; profiles: string[]; run: Run; onStarted: (id: string) => void }) {
  const typing = usePlainTyping();
  const [folder, setFolder] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [model, setModel] = useState('');
  const [profile, setProfile] = useState('');
  const [mode, setMode] = useState<PermissionMode | ''>('');
  const [busy, setBusy] = useState(false);
  const shownFolder = folder ?? chats?.folder ?? '';
  const shownMode = mode || chats?.permissionMode || 'auto';
  const start = () => run(async () => {
    setBusy(true);
    try {
      const chat = await api.startChat({
        ...(folder ? { folder } : {}), ...(model.trim() ? { model: model.trim() } : {}), ...(profile ? { profile } : {}), ...(mode ? { permissionMode: mode } : {}),
      });
      onStarted(chat.id);
    } finally {
      setBusy(false);
    }
  });
  return (
    <div className="page-view">
      <header className="session-head"><div className="session-head-text"><h2>New chat</h2>
        <div className="muted">A Claude Code session of your own, with no project, workflow or manager. It asks you directly.</div></div></header>
      <div className="page-body">
        <div className="form">
          {browsing
            ? <FolderBrowser load={api.browse} reloadKey="chat" start={shownFolder || undefined} onPick={(p) => { setFolder(p); setBrowsing(false); }} pickLabel="Chat in this folder" />
            : <p>Folder: <span className="mono">{shownFolder || '…'}</span> <button className="small" onClick={() => setBrowsing(true)}>Change</button></p>}
          <label>
            Model <span className="muted">(empty: Claude Code's own default)</span>
            <input {...typing} value={model} onChange={(e) => setModel(e.target.value)} placeholder="opus, sonnet, haiku or a full model name" />
          </label>
          {profiles.length > 1 && (
            <label>
              Profile <span className="muted">(what it gets of your own plugins, MCP servers and tools)</span>
              <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                <option value="">full: your whole setup</option>
                {profiles.filter((n) => n !== 'full').map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          )}
          <label>
            Permission mode <span className="muted">(changeable in the chat; what always goes to you is asked in every mode)</span>
            <select value={shownMode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              {PERMISSION_MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </select>
          </label>
        </div>
        <button className="primary" disabled={busy || browsing || !chats} onClick={() => void start()}>{busy ? 'Starting…' : 'Start chat'}</button>
      </div>
    </div>
  );
}

/**
 * The Chats tab in Settings (issue #366): General (where new chats start and in which mode, both from Ledung's config),
 * What always goes to you (the list is exactly what is enforced, with the config's own patterns shown on top), and
 * Look, the chats' name colour (saved at once). One Save bar for the list, as in a project's tab.
 */
export function ChatsSettingsView({ view, chats, run, onOpen }: { view: string; chats: ChatsInfo | null; run: Run; onOpen: (view: string) => void }) {
  const narrow = useNarrow(NARROW_QUERY);
  const group = tabGroupOf(tabView(view) ?? { project: null, group: null }, narrow);
  const server = { commandPatterns: chats?.sensitive.commandPatterns ?? [], pathPatterns: chats?.sensitive.pathPatterns ?? [] };
  const list = useEdited(server, (a, b) => JSON.stringify(a) !== JSON.stringify(b));
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 3000);
    return () => clearTimeout(t);
  }, [justSaved]);
  if (!chats) return <div className="page-body"><p className="muted">Loading…</p></div>;
  const count = (['commandPatterns', 'pathPatterns'] as const).filter((k) => JSON.stringify(list.saved[k]) !== JSON.stringify(list.value[k])).length;
  const fixed = [...chats.fromConfig.commandPatterns, ...chats.fromConfig.pathPatterns, ...chats.fromConfig.mcpTools];
  const save = () => run(async () => {
    setBusy(true);
    try {
      const saved = (await api.updateChats({ ...list.value, mcpTools: chats.sensitive.mcpTools })).sensitive;
      list.done({ commandPatterns: saved.commandPatterns, pathPatterns: saved.pathPatterns });
      setJustSaved(true);
    } finally {
      setBusy(false);
    }
  });
  return (
    <SettingsSplit groups={CHATS_GROUPS} current={group} words={{ safety: String(list.value.commandPatterns.length + list.value.pathPatterns.length) }}
      marked={count ? new Set(['safety']) : undefined} narrow={narrow} onOpen={(g) => onOpen(g === null ? 'chats' : tabGroupView(null, g))}
      foot={<SaveBar count={count} saved={justSaved} busy={busy} note="running chats keep theirs; new and resumed ones get these" onSave={() => void save()} onDiscard={list.discard} />}>
      {group === 'general' && (
        <section>
          <div className="settings-h"><h3>General</h3><Where kind="config" /></div>
          <p className="muted">Chats are sessions with no project. They ask you directly, and run on this computer. Both of these are set in Ledung's config ("chats"); each new chat can choose another.</p>
          <p><span className="field-name">Folder</span>: <span className="mono">{chats.folder}</span></p>
          <p><span className="field-name">Permission mode</span>: {MODE_LABEL[chats.permissionMode]}</p>
        </section>
      )}
      {group === 'safety' && (
        <section>
          <h3>What always goes to you</h3>
          <div className="safety">
            <SensitiveList value={list.value} onChange={(l) => { list.set(l); setJustSaved(false); }} heading={false} />
            {fixed.length > 0 && (
              <p className="muted">Also always asked, from Ledung's config: {fixed.map((p, i) => <Fragment key={p}>{i ? ', ' : ''}<code>{p}</code></Fragment>)}.</p>
            )}
          </div>
        </section>
      )}
      {group === 'look' && (
        <section>
          <h3>Look</h3>
          <p className="muted">The chats' names in the sidebar and their headers. Saved at once, for every browser.</p>
          <ChatsColourPicker colour={chats.colour} run={run} />
        </section>
      )}
    </SettingsSplit>
  );
}
