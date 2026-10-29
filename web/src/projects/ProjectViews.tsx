// Projects in the page (projects and accounts, P1 and P2): adding an existing project or creating a
// new one, Ledung's own folder browser (also inside containers), a project's tab in Settings (issue #366), and the
// project's manager before it has started.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  PERMISSION_MODES, type AccountInfoView, type BoardStatus, type ContainerInfoView, type FolderListingView, type PermissionMode, type ProfilesView, type ProjectInfo, type WorkflowCheckView,
} from '../../../src/shared/protocol.ts';
import { SUGGESTIONS, missingSuggestions, suggestionName, withSuggestions } from '../../../src/shared/sensitive-suggestions.ts';
import { DEFAULT_TIERS } from '../../../src/shared/questions.ts';
import { api } from '../api.ts';
import { ProjectBoard, boardBlocked, boardChanges, boardFormOf, saveBoard } from '../components/BoardViews.tsx';
import { ProjectUsagePublish } from '../components/UsagePublishSettings.tsx';
import { renameInFilter } from '../waitingLists.ts';
import { LockdownFrame } from '../components/LockdownFrame.tsx';
import { frameLevel } from '../lockdownFrame.ts';
import { usePlainTyping } from '../usePlainTyping.ts';
import { SkillPicker, skillCounts, useSkillList } from '../components/SkillPicker.tsx';
import { NameColourPickers } from '../components/ProjectName.tsx';
import { InheritLine, SaveBar, SettingsSplit, useNarrow } from '../components/SettingsFrame.tsx';
import { NARROW_QUERY } from '../sidebarSize.ts';
import { PROJECT_GROUPS, tabGroupOf, tabGroupView, tabView } from '../settingsGroups.ts';
import { useEdited } from '../useEdited.ts';
import {
  FIELD_GROUP, RESET, changedFields, chooseWorkflow, emptySettings, followsWorkflow, inherit, profileDefaults, settingsOf, tierLines, toApi, type Settings,
} from './projectSettings.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;

const MODE_LABEL: Record<PermissionMode, string> = { default: 'Ask', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan' };

/** What the fields of a project's tab show of Ledung's defaults (issue #366); absent in Add project, whose form is unchanged. */
interface Defaults { profiles: { manager: string; session: string } }

/** A field's props: the whole form's settings, and Ledung's defaults in a project's tab. */
interface FieldProps { value: Settings; onChange: (s: Settings) => void; defaults?: Defaults }

/**
 * A field's frame: its name (".field-name", which the browser check and search read), its hint, the "Ledung default"
 * line in a project's tab, and the control. The label points at the control by id, so Reset is never the label's control.
 */
function Field({ name, hint, line, children }: { name: string; hint?: string; line?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}><span className="field-name">{name}</span>{hint && <> <span className="muted">{hint}</span></>}</label>
      {line}
      {children(id)}
    </div>
  );
}

/** The "Ledung default" line of a field with a Ledung-wide default (issue #366), in a project's tab. */
function inheritLine(f: FieldProps, key: keyof typeof RESET, def: string): ReactNode {
  if (!f.defaults) return null;
  const i = inherit(f.value[key] as string | object, def);
  return <InheritLine follows={i.follows} text={i.text} onReset={() => f.onChange({ ...f.value, [key]: RESET[key] })} />;
}

const setter = (f: FieldProps, k: keyof Settings) => (e: { target: { value: string } }) => f.onChange({ ...f.value, [k]: e.target.value });

function NameField(f: FieldProps) {
  const typing = usePlainTyping();
  return <Field name="Name">{(id) => <input id={id} {...typing} value={f.value.name} onChange={setter(f, 'name')} maxLength={48} placeholder="e.g. Website" />}</Field>;
}

function AccountField(f: FieldProps & { accounts: AccountInfoView[]; container?: boolean }) {
  return (
    <Field name="Claude account" hint="(for its manager and all its sessions)" line={inheritLine(f, 'account', "this computer's own login")}>
      {(id) => (
        <select id={id} value={f.value.account} onChange={setter(f, 'account')}>
          <option value="">default: this computer's own login</option>
          {f.accounts.map((a) => (
            <option key={a.name} value={a.name} disabled={f.container && a.kind === 'folder'}>
              {a.name}{a.email ? ` (${a.email})` : ''}{f.container && a.kind === 'folder' ? ' — login folders work only on this computer' : ''}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function ModelFields(f: FieldProps) {
  const typing = usePlainTyping();
  return (
    <>
      <Field name="Model" hint="(empty: from the project's Claude settings, else Claude Code's default)" line={inheritLine(f, 'model', "the project's Claude settings, else Claude Code's")}>
        {(id) => (
          <>
            <input id={id} {...typing} value={f.value.model} onChange={setter(f, 'model')} list="ledung-models" placeholder="opus, sonnet, haiku or a full model name" />
            <datalist id="ledung-models"><option value="opus" /><option value="sonnet" /><option value="haiku" /></datalist>
          </>
        )}
      </Field>
      <Field name="Model for its manager" hint="(empty: the same as its sessions)" line={inheritLine(f, 'managerModel', 'the same as its sessions')}>
        {(id) => <input id={id} {...typing} value={f.value.managerModel} onChange={setter(f, 'managerModel')} list="ledung-models" placeholder="opus, sonnet, haiku or a full model name" />}
      </Field>
    </>
  );
}

function ModeField(f: FieldProps) {
  return (
    <Field name="Permissions for new sessions" line={inheritLine(f, 'permissionMode', 'Ask')}>
      {(id) => (
        <select id={id} value={f.value.permissionMode} onChange={setter(f, 'permissionMode')}>
          <option value="">Ask (default)</option>
          {PERMISSION_MODES.filter((m) => m !== 'default').map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </select>
      )}
    </Field>
  );
}

function ExtraFoldersField(f: FieldProps) {
  const typing = usePlainTyping();
  return (
    <Field name="Extra folders" hint="(full paths, one per line: besides the project folder and folders inside it, its manager may start sessions in folders under these, such as where its git worktrees go. Empty: none)">
      {(id) => <textarea id={id} {...typing} rows={2} value={f.value.extraFolders} onChange={setter(f, 'extraFolders')} className="mono" />}
    </Field>
  );
}

function GrantField(f: FieldProps) {
  const typing = usePlainTyping();
  return (
    <Field name="What the manager may decide for you" hint="(empty: it asks you about everything)">
      {(id) => <textarea id={id} {...typing} rows={2} value={f.value.managerGrant} onChange={setter(f, 'managerGrant')} placeholder="e.g. Ordinary development decisions: code structure, naming, which tests to add." />}
    </Field>
  );
}

function ToolSwitches(f: FieldProps) {
  return (
    <>
      <label className="toggle">
        <input type="checkbox" checked={f.value.projectToolsUnasked} onChange={(e) => f.onChange({ ...f.value, projectToolsUnasked: e.target.checked })} />
        {' '}<span className="field-name">Its manager adds projects and starts or stops other managers without asking you</span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={f.value.projectSettingsTools} onChange={(e) => f.onChange({ ...f.value, projectSettingsTools: e.target.checked })} />
        {' '}<span><span className="field-name">Its manager reads and changes workflow settings of your projects</span> <span className="muted">(not locked ones; a new grant, a new dev ship command or a sensitive pattern removed still asks you)</span></span>
      </label>
    </>
  );
}

function DevShipField(f: FieldProps) {
  const typing = usePlainTyping();
  return (
    <Field name="Dev ship command" hint="(a pattern the whole command must match, e.g. npm run ship:dev; while you're away and allow dev ship, the manager may run it. Empty: never)">
      {(id) => <input id={id} {...typing} value={f.value.devShipCommand} onChange={setter(f, 'devShipCommand')} className="mono" />}
    </Field>
  );
}

/**
 * A session profile (#20): how much of your own Claude Code setup a session gets. The profiles are
 * defined in Ledung's config; a name the config no longer has stays visible so it can be changed.
 */
function ProfileChoice(f: FieldProps & { role: 'manager' | 'session'; profiles: string[] }) {
  const key = f.role === 'manager' ? 'managerProfile' : 'sessionProfile';
  const value = f.value[key];
  const names = value && !f.profiles.includes(value) ? [...f.profiles, value] : f.profiles;
  return (
    <Field name={f.role === 'manager' ? 'Profile for its manager' : 'Profile for its sessions'} hint="(what it gets of your own plugins, MCP servers and tools; Ledung's tools always stay)"
      line={f.defaults && inheritLine(f, key, f.defaults.profiles[f.role])}>
      {(id) => (
        <select id={id} value={value} onChange={setter(f, key)}>
          <option value="">default (from the config)</option>
          {names.map((n) => <option key={n} value={n}>{n}{f.profiles.includes(n) ? '' : ' — not in the config'}</option>)}
        </select>
      )}
    </Field>
  );
}

/** The project's skill picker (#300), folded with how many are on; `project` none: not added yet, so this computer's own login. */
function ProjectSkills(f: FieldProps & { project: string | undefined }) {
  const { list, error } = useSkillList(f.project);
  return (
    <div className="field">
      {f.defaults && inheritLine(f, 'skills', `Settings → Sessions → Skills${list ? `, ${skillCounts(list, {}, list.defaults)}` : ''}`)}
      <details className="skills-choice">
        <summary><span className="field-name">Skills</span>{list ? `: ${skillCounts(list, f.value.skills, list.defaults)}` : ''} <span className="muted">(which of your own skills its manager and sessions get; unchosen ones follow Settings)</span></summary>
        <SkillPicker list={list} error={error} value={f.value.skills} onChange={(skills) => f.onChange({ ...f.value, skills })} defaults={list?.defaults ?? {}} />
      </details>
    </div>
  );
}

/** The configured workflows, and whether a folder has the project's config for the one named (none: the first); null until known. */
function useWorkflowCheck(folder: string | undefined, config: string, name: string): WorkflowCheckView | null {
  const [check, setCheck] = useState<WorkflowCheckView | null>(null);
  useEffect(() => {
    let current = true;
    api.workflowCheck(folder, config.trim() || undefined, name || undefined).then((c) => { if (current) setCheck(c); }, () => {});
    return () => { current = false; };
  }, [folder, config, name]);
  return check;
}

/** Said when a project follows the workflow but its project config is missing; nothing otherwise. */
function WorkflowNotice({ check, settings, container }: { check: WorkflowCheckView | null; settings: Settings; container: boolean }) {
  if (!check?.on || !followsWorkflow(settings, container) || check.exists !== false) return null;
  return (
    <p className="banner">
      This project has no <span className="mono">{check.projectConfig}</span>. Its sessions will follow the process but stop where it needs
      the project's settings. Write that file, or choose None as its workflow.
    </p>
  );
}

/** Workflow and its project config (issues #21, #132), when the config names a workflow. */
function WorkflowFields(f: FieldProps & { workflow: WorkflowCheckView; container: boolean }) {
  const typing = usePlainTyping();
  const { workflow, container } = f;
  return (
    <>
      <Field name="Workflow" hint="(its sessions are told to read the process first)">
        {(id) => (
          <select id={id}
            value={followsWorkflow(f.value, container) ? f.value.workflowName || workflow.workflows[0] : ''}
            onChange={(e) => f.onChange(chooseWorkflow(f.value, e.target.value, container))}
          >
            <option value="">None</option>
            {workflow.workflows.map((n) => <option key={n} value={n}>{n}</option>)}
            {/* Kept as it is when taken out of the config since, until another is chosen. */}
            {f.value.workflowName && !workflow.workflows.includes(f.value.workflowName) && (
              <option value={f.value.workflowName}>{f.value.workflowName} (not in the config)</option>
            )}
          </select>
        )}
      </Field>
      {followsWorkflow(f.value, container) && workflow.on && (
        <Field name="Project config for the workflow" hint={`(inside the project folder; empty: ${workflow.projectConfig})`}>
          {(id) => <input id={id} {...typing} value={f.value.workflowConfig} onChange={setter(f, 'workflowConfig')} className="mono" />}
        </Field>
      )}
    </>
  );
}

function TicketFields(f: FieldProps) {
  const typing = usePlainTyping();
  return (
    <>
      <Field name="Ticket pattern" hint="(e.g. [A-Z]+-\d+)">
        {(id) => <input id={id} {...typing} value={f.value.ticketPattern} onChange={setter(f, 'ticketPattern')} className="mono" />}
      </Field>
      <Field name="Ticket link" hint="({id} is replaced by the ticket)">
        {(id) => <input id={id} {...typing} value={f.value.ticketUrl} onChange={setter(f, 'ticketUrl')} className="mono" placeholder="https://tracker.example/browse/{id}" />}
      </Field>
    </>
  );
}

function TiersField(f: FieldProps) {
  const typing = usePlainTyping();
  return (
    <Field name="Question tiers" hint="(one per line, first first: every question gives one, and Waiting for you groups them in this order. Never empty: clearing it brings back the five standard ones)">
      {(id) => (
        <textarea id={id} {...typing}
          rows={5}
          value={f.value.questionTiers}
          onChange={setter(f, 'questionTiers')}
          onBlur={() => { if (!tierLines(f.value.questionTiers).length) f.onChange({ ...f.value, questionTiers: DEFAULT_TIERS.join('\n') }); }}
        />
      )}
    </Field>
  );
}

/**
 * The project's sensitive list (sensitive-always): exactly what is shown is what is enforced, nothing
 * hidden in the code. A new project starts with the suggestions; they can be deleted like anything added.
 */
export function SensitiveList<T extends { commandPatterns: string[]; pathPatterns: string[] }>({ value, onChange, heading = true }: {
  value: T; onChange: (s: T) => void;
  /** False in a Settings tab, whose section heading names it (issue #366): the explanation stays. */
  heading?: boolean;
}) {
  const typing = usePlainTyping();
  const [kind, setKind] = useState<'command' | 'path'>('command');
  const [pattern, setPattern] = useState('');
  const [error, setError] = useState<string | null>(null);
  const entries = [
    ...value.commandPatterns.map((p) => ({ kind: 'command' as const, pattern: p })),
    ...value.pathPatterns.map((p) => ({ kind: 'path' as const, pattern: p })),
  ];
  const missing = missingSuggestions(value.commandPatterns, value.pathPatterns);
  const remove = (e: { kind: 'command' | 'path'; pattern: string }) => onChange({
    ...value,
    commandPatterns: e.kind === 'command' ? value.commandPatterns.filter((p) => p !== e.pattern) : value.commandPatterns,
    pathPatterns: e.kind === 'path' ? value.pathPatterns.filter((p) => p !== e.pattern) : value.pathPatterns,
  });
  const add = () => {
    const p = pattern.trim();
    if (!p) return;
    try {
      new RegExp(p, 'i');
    } catch (e) {
      setError(`Not a valid regular expression: ${(e as Error).message}`);
      return;
    }
    setError(null);
    setPattern('');
    onChange(kind === 'command'
      ? { ...value, commandPatterns: value.commandPatterns.includes(p) ? value.commandPatterns : [...value.commandPatterns, p] }
      : { ...value, pathPatterns: value.pathPatterns.includes(p) ? value.pathPatterns : [...value.pathPatterns, p] });
  };
  return (
    <div className="sensitive-list">
      <p>
        {heading
          ? <><strong>Always goes to you</strong>{' '}<span className="muted">(no session, manager or "for this session" permission can allow these; you decide each time, in every permission mode)</span></>
          : <span className="muted">No session, manager or "for this session" permission can allow these; you decide each time, in every permission mode.</span>}
      </p>
      {entries.length === 0 && (
        <p className="muted">Nothing is sensitive here; every action is decided by the permission mode and the manager.</p>
      )}
      <ul>
        {entries.map((e) => {
          const name = suggestionName(e.pattern, e.kind);
          return (
            <li key={e.kind + e.pattern}>
              <span className="sensitive-entry">
                <span>{name ?? (e.kind === 'command' ? 'Commands matching' : 'Files matching')}</span>
                <code className={name ? 'muted' : undefined}>{e.pattern}</code>
              </span>
              <button type="button" className="small deny" onClick={() => remove(e)} aria-label={`Delete: ${name ?? e.pattern}`}>Delete</button>
            </li>
          );
        })}
      </ul>
      {missing.length > 0 && (
        <p>
          <button type="button" className="small" onClick={() => onChange(withSuggestions(value))}>
            Add suggested ({missing.length} of {SUGGESTIONS.length} not in the list)
          </button>
        </p>
      )}
      <div className="sensitive-add">
        <select value={kind} onChange={(e) => setKind(e.target.value as 'command' | 'path')} aria-label="What the pattern is matched against">
          <option value="command">A command</option>
          <option value="path">A file path</option>
        </select>
        <input {...typing}
          className="mono" value={pattern} placeholder="regular expression, e.g. \bmigrate:prod\b"
          onChange={(e) => { setPattern(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <button type="button" className="small" onClick={add} disabled={!pattern.trim()}>Add</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Add project's form: every field in one column, as before the project tab (issue #366) regrouped them. */
function SettingsForm({ value, onChange, accounts, profiles, container, workflow, lockdownB }: {
  value: Settings; onChange: (s: Settings) => void; accounts: AccountInfoView[]; profiles: string[]; container?: boolean; workflow?: WorkflowCheckView | null;
  /** Why lockdown level B can't be chosen here; null: it can (issue #109). */
  lockdownB: string | null;
}) {
  const f: FieldProps = { value, onChange };
  return (
    <div className="form">
      <NameField {...f} />
      <AccountField {...f} accounts={accounts} container={container} />
      <ModelFields {...f} />
      <ModeField {...f} />
      <GrantField {...f} />
      <ToolSwitches {...f} />
      <ProjectUsagePublish value={value} onChange={onChange} />
      <LockdownChoice value={value} onChange={onChange} levelB={lockdownB} container={container} />
      <ProfileChoice {...f} role="manager" profiles={profiles} />
      <ProfileChoice {...f} role="session" profiles={profiles} />
      <ProjectSkills {...f} project={undefined} />
      {!!workflow?.workflows.length && <WorkflowFields {...f} workflow={workflow} container={!!container} />}
      <details>
        <summary>More: actions that always go to you, tickets, question tiers{container ? '' : ' and extra folders'}</summary>
        <SensitiveList value={value} onChange={onChange} />
        <DevShipField {...f} />
        <TicketFields {...f} />
        <TiersField {...f} />
        {!container && <ExtraFoldersField {...f} />}
      </details>
    </div>
  );
}

/**
 * Lockdown (issue #109): off by default. Level B can't be chosen where `levelB` says why (native Windows,
 * held by Martin); turning it off or down, or letting the board, Remote Control or a host in, needs the open page.
 */
function LockdownChoice({ value, onChange, levelB, container }: { value: Settings; onChange: (s: Settings) => void; levelB: string | null; container?: boolean }) {
  const typing = usePlainTyping();
  const on = value.lockdownLevel !== 'off';
  const b = value.lockdownLevel === 'B';
  return (
    <>
      <label>
        <span className="field-name">Lockdown</span> <span className="muted">(walls the project off from other projects' managers and sessions; only you can turn it off or down again)</span>
        <select value={value.lockdownLevel} onChange={(e) => onChange({ ...value, lockdownLevel: e.target.value as Settings['lockdownLevel'] })}>
          <option value="off">Off (default): managers and sessions reach it as usual</option>
          <option value="A">Level A: nothing reaches in; it may still reach out</option>
          <option value="B" disabled={!!levelB && !b}>Level B, nearly air-gapped: nothing reaches in or out{levelB ? ': not available here' : ''}</option>
        </select>
      </label>
      {levelB && <p className="muted">{levelB}</p>}
      {on && (
        <>
          <p className="muted">
            Other projects' managers see only its name: they can't message it (except, at level A, to answer each of its messages once), start or stop its manager,
            or use its folders. While a project is locked, every other session on this computer is kept out of its folders: file tools on every system,
            and shell commands run in Claude Code's sandbox on macOS and Linux (not on Windows, where only the file tools are stopped).
            Running sessions take it when Ledung restarts them, which it does as soon as each is free; their conversations are kept.
          </p>
          {b && (
            <p className="muted">
              Level B also closes the way out. Its manager has no tools for other managers, other projects or the board. Its sessions get none of your
              MCP servers, plugins, connectors or own settings, no web tools, and can't read outside their folders.
              {container
                ? ' Its container is checked before every start: only the project folder mounted, no Docker socket, and only the network you mark below.'
                : ' Their shell commands run in the sandbox with no network but the hosts below.'}
              {' '}Only what Claude Code and a shell need of Ledung's environment is passed on.
            </p>
          )}
          {!b && (
            <label className="toggle">
              <input type="checkbox" checked={value.lockdownBoard} onChange={(e) => onChange({ ...value, lockdownBoard: e.target.checked })} />
              {' '}Keep the message board on for it
            </label>
          )}
          <label className="toggle">
            <input type="checkbox" checked={value.lockdownRemoteControl} onChange={(e) => onChange({ ...value, lockdownRemoteControl: e.target.checked })} />
            {' '}Keep Remote Control for its manager
          </label>
          {b && !container && (
            <label>
              Hosts its shell commands may reach <span className="muted">(one per line, such as registry.npmjs.org or *.example.com; empty: no network)</span>
              <textarea {...typing} rows={3} value={value.lockdownNetwork} onChange={(e) => onChange({ ...value, lockdownNetwork: e.target.value })} />
            </label>
          )}
          {b && container && (
            <label>
              Its island network <span className="muted">(the Docker network its container may be on; mark it only once it reaches nothing but what the project may)</span>
              <input {...typing} value={value.lockdownDockerNetwork} onChange={(e) => onChange({ ...value, lockdownDockerNetwork: e.target.value })} />
            </label>
          )}
        </>
      )}
    </>
  );
}

/** Ledung's own folder browser: folders on this computer, or inside a container. */
export function FolderBrowser(props: {
  load: (path?: string) => Promise<FolderListingView>;
  /** Changes when the place to browse changes (e.g. another container). */
  reloadKey: string;
  start?: string;
  onPick: (path: string) => void;
  pickLabel: string;
}) {
  const [listing, setListing] = useState<FolderListingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const go = (path?: string) => {
    setError(null);
    setLoading(true);
    props.load(path).then(setListing, (e: Error) => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => go(props.start), [props.reloadKey, props.start]);
  return (
    <div className="browser">
      {error && <p className="error">{error}</p>}
      {loading && <p className="muted">Loading folders…</p>}
      {listing && (
        <>
          <div className="browser-head">
            <button className="small" disabled={!listing.parent} onClick={() => go(listing.parent ?? undefined)} title="One folder up">↑ Up</button>
            <span className="mono browser-path">{listing.path}</span>
          </div>
          {listing.roots.length > 1 && (
            <div className="browser-roots">
              {listing.roots.map((r) => <button key={r} className="small" onClick={() => go(r)}>{r}</button>)}
            </div>
          )}
          <ul className="browser-list">
            {!listing.entries.length && <li className="muted">No folders here.</li>}
            {listing.entries.map((e) => (
              <li key={e.path}>
                <button className="link" onClick={() => go(e.path)}>📁 {e.name}</button>
                {e.git !== null && <span className="muted"> · git{e.git ? ` · ${e.git}` : ''}</span>}
                {e.project && <span className="chip">project {e.project}</span>}
              </li>
            ))}
          </ul>
          <div className="browser-foot">
            <button className="primary" onClick={() => props.onPick(listing.path)}>{props.pickLabel}</button>
          </div>
        </>
      )}
    </div>
  );
}

type AddKind = 'local' | 'docker' | 'new';

export function AddProjectView({ run, onAdded, accounts, defaultAccount, profiles, lockdownB }: { run: Run; onAdded: (p: ProjectInfo) => void; accounts: AccountInfoView[]; defaultAccount: string | null; profiles: string[]; lockdownB: string | null }) {
  const typing = usePlainTyping();
  const [kind, setKind] = useState<AddKind>('local');
  const [folder, setFolder] = useState<string | null>(null);
  const [containers, setContainers] = useState<ContainerInfoView[] | null>(null);
  const [containerError, setContainerError] = useState<string | null>(null);
  const [loadingContainers, setLoadingContainers] = useState(false);
  const [container, setContainer] = useState('');
  const [user, setUser] = useState('');
  // The account chosen for new projects in Settings → Accounts (issue #283), changeable here.
  const [settings, setSettings] = useState<Settings>(() => ({ ...emptySettings(), account: defaultAccount ?? '' }));
  // The choice may arrive after the form opens (a reload on Add project): follow it until another account is picked here.
  const shownDefault = useRef(defaultAccount ?? '');
  useEffect(() => {
    const was = shownDefault.current;
    const next = defaultAccount ?? '';
    shownDefault.current = next;
    setSettings((s) => (s.account === was ? { ...s, account: next } : s));
  }, [defaultAccount]);
  const [parent, setParent] = useState<string | null>(null);
  const [browsingParent, setBrowsingParent] = useState(false);
  const [github, setGithub] = useState(false);
  const [task, setTask] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A folder in a container can't be looked into from here; a new project has no config yet.
  const workflow = useWorkflowCheck(kind === 'local' && folder ? folder : undefined, settings.workflowConfig, settings.workflowName);
  const workflowShown = workflow && kind !== 'local' ? { ...workflow, exists: kind === 'new' ? false : null } : workflow;

  // Listing containers takes a few seconds (docker ps and inspect), so say so; asked again whenever
  // the container option is chosen, so one started after the form was opened appears.
  const loadContainers = () => {
    setContainerError(null);
    setLoadingContainers(true);
    api.containers().then(setContainers, (e: Error) => setContainerError(e.message)).finally(() => setLoadingContainers(false));
  };

  useEffect(() => {
    setFolder(null);
    setNote(null);
    if (kind === 'docker') loadContainers();
    // A login folder works only on this computer: a container project starts on default instead.
    if (kind === 'docker' && accounts.find((a) => a.name === settings.account)?.kind === 'folder') setSettings((s) => ({ ...s, account: '' }));
    if (kind === 'new' && !parent) api.projectsFolder().then((r) => setParent(r.path), () => {});
  }, [kind]);

  const pick = (path: string) => {
    setFolder(path);
    const last = path.split(/[\\/]/).filter(Boolean).pop() ?? '';
    if (!settings.name) setSettings({ ...settings, name: last.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 48) });
  };

  const submit = () => run(async () => {
    setBusy(true);
    // A new project that follows the first workflow stores its name, so it keeps it whatever the config's order (issue #132).
    const first = workflow?.workflows[0];
    const chosen = first && !settings.workflowName && followsWorkflow(settings, kind === 'docker') ? { ...settings, workflowName: first } : settings;
    try {
      if (kind === 'new') {
        const r = await api.createProject({ parent: parent ?? undefined, github, task: task.trim() || undefined, settings: toApi(chosen, null) });
        if (r.warning) setNote(r.warning);
        onAdded(r.project);
      } else if (kind === 'local') {
        onAdded(await api.addProject({ ...toApi(chosen, null), runner: 'local', path: folder }));
      } else {
        onAdded(await api.addProject({ ...toApi(chosen, null), runner: 'docker', container, pathInContainer: folder, ...(user ? { user } : {}) }));
      }
    } finally {
      setBusy(false);
    }
  });

  const ready = settings.name.trim() && (kind === 'new' || folder);
  return (
    <div className="page-view">
      <header className="session-head"><div className="session-head-text"><h2>Add a project</h2>
        <div className="muted">A project is a folder where Claude Code works, with its settings and one manager.</div></div></header>
      <div className="page-body">
        <div className="segmented" role="tablist">
          <button className={kind === 'local' ? 'on' : ''} onClick={() => setKind('local')}>Folder on this computer</button>
          <button className={kind === 'docker' ? 'on' : ''} onClick={() => setKind('docker')}>Folder in a container</button>
          <button className={kind === 'new' ? 'on' : ''} onClick={() => setKind('new')}>New project</button>
        </div>

        {kind === 'local' && (folder
          ? <p>Folder: <span className="mono">{folder}</span> <button className="small" onClick={() => setFolder(null)}>Change</button></p>
          : <FolderBrowser load={api.browse} reloadKey="local" onPick={pick} pickLabel="Use this folder" />)}

        {kind === 'docker' && (
          <>
            {containerError && <p className="error">{containerError}</p>}
            {loadingContainers && <p className="muted">Looking for running containers…</p>}
            {!loadingContainers && (containers || containerError) && (
              <p><button className="small" onClick={loadContainers}>Refresh containers</button></p>
            )}
            {containers && !containers.length && <p className="muted">No containers are running. Start the container first.</p>}
            {containers && containers.length > 0 && (
              <div className="form">
                <label>
                  Container
                  <select value={container} onChange={(e) => {
                    setContainer(e.target.value);
                    setUser(containers.find((c) => c.name === e.target.value)?.user ?? '');
                    setFolder(null);
                  }}>
                    <option value="">Choose a running container</option>
                    {containers.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.image})</option>)}
                  </select>
                </label>
                <label>
                  Run as user <span className="muted">(empty: the container's default)</span>
                  <input {...typing} value={user} onChange={(e) => setUser(e.target.value)} />
                </label>
              </div>
            )}
            {container && (folder
              ? <p>Folder: <span className="mono">{container}:{folder}</span> <button className="small" onClick={() => setFolder(null)}>Change</button></p>
              : <FolderBrowser load={(p) => api.browseContainer(container, user, p)} reloadKey={`${container}|${user}`} onPick={pick} pickLabel="Use this folder" />)}
          </>
        )}

        {kind === 'new' && (
          <div className="form">
            <p className="muted">Ledung creates a folder named after the project, with a git repository.</p>
            {browsingParent
              ? <FolderBrowser load={api.browse} reloadKey="parent" start={parent ?? undefined} onPick={(p) => { setParent(p); setBrowsingParent(false); }} pickLabel="Create it in this folder" />
              : <p>In: <span className="mono">{parent ?? '…'}</span> <button className="small" onClick={() => setBrowsingParent(true)}>Change</button></p>}
            <label className="toggle"><input type="checkbox" checked={github} onChange={(e) => setGithub(e.target.checked)} /> Create a private GitHub repository too</label>
            <label>
              What is the project for? <span className="muted">(optional: given to its manager as its first task)</span>
              <textarea {...typing} rows={3} value={task} onChange={(e) => setTask(e.target.value)} />
            </label>
          </div>
        )}

        {(kind === 'new' || folder) && (
          <>
            <h3>Settings</h3>
            <SettingsForm value={settings} onChange={setSettings} accounts={accounts} profiles={profiles} container={kind === 'docker'} workflow={workflow} lockdownB={lockdownB} />
            <WorkflowNotice check={workflowShown} settings={settings} container={kind === 'docker'} />
            <button className="primary" disabled={!ready || busy} onClick={() => void submit()}>
              {busy ? 'Adding…' : kind === 'new' ? 'Create project' : 'Add project'}
            </button>
          </>
        )}
        {note && <p className="banner">{note}</p>}
      </div>
    </div>
  );
}

/**
 * A project's tab in Settings (issue #366, mockup E; Martin 2026-10-28, Ledung question #325): today's project page in
 * groups, one on screen at a time at its own address, and one Save bar for the whole tab, the Message board included.
 * What is typed is kept while moving between the tab's groups. "What always goes to you" is a group of its own, and the
 * name colours, moved here from the manager's ⚙, still save at once.
 */
export function ProjectSettingsView({ view, project, projects, run, onOpen, onRemoved, onRenamed, accounts, profiles, board, lockdownB }: {
  view: string; board: BoardStatus | null; project: ProjectInfo; projects: ProjectInfo[]; run: Run; onOpen: (view: string) => void; onRemoved: () => void;
  /** After a rename: the view to open, the same group under the new name. */
  onRenamed: (view: string) => void;
  accounts: AccountInfoView[]; profiles: string[]; lockdownB: string | null;
}) {
  const narrow = useNarrow(NARROW_QUERY);
  const group = tabGroupOf(tabView(view) ?? { project: project.name, group: null }, narrow);
  const edited = useEdited(settingsOf(project), (a, b) => changedFields(a, b).length > 0);
  const boardEdit = useEdited(boardFormOf(board, project.name), (a, b) => boardChanges(b, a) > 0);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [profileView, setProfileView] = useState<ProfilesView | null>(null);
  useEffect(() => { api.profiles().then(setProfileView, () => {}); }, []);
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 3000);
    return () => clearTimeout(t);
  }, [justSaved]);
  const settings = edited.value;
  const container = project.runner === 'docker';
  const workflow = useWorkflowCheck(project.runner === 'local' ? project.path : undefined, settings.workflowConfig, settings.workflowName);
  const following = workflow?.on && followsWorkflow(settings, container) ? settings.workflowName || workflow.workflows[0] || null : null;
  const f: FieldProps = {
    value: settings,
    onChange: (s) => { edited.set(s); setJustSaved(false); },
    defaults: { profiles: profileDefaults(profileView, following) },
  };
  const changed = changedFields(edited.saved, settings);
  const boardCount = boardChanges(boardEdit.value, boardEdit.saved);
  const count = changed.length + boardCount;
  const marked = new Set(changed.map((k) => FIELD_GROUP[k]));
  if (boardCount) marked.add('board');
  const renaming = settings.name.trim() !== project.name;
  const words: Record<string, string> = {
    safety: String(settings.commandPatterns.length + settings.pathPatterns.length),
    powers: settings.lockdownLevel === 'off' ? '' : `lockdown ${settings.lockdownLevel}`,
    board: boardEdit.saved.enabled ? '' : 'off',
  };
  // The board first, under the name it is saved under now; then the project, which a new name goes with in one
  // request (issue #116): refused, nothing changes and the tab keeps what was typed; saved, it moves to the new name.
  const save = () => run(async () => {
    setBusy(true);
    try {
      if (boardCount) {
        await saveBoard(project.name, boardEdit.value);
        boardEdit.done(boardEdit.value);
      }
      if (changed.length && renaming) {
        const name = (await api.renameProject(project.name, settings.name.trim(), toApi(settings, project))).name;
        renameInFilter(localStorage, project.name, name);
        onRenamed(group ? tabGroupView(name, group) : `ps:${name}`);
        return;
      }
      if (changed.length) edited.done(settingsOf(await api.updateProject(project.name, toApi(settings, project))));
      setJustSaved(true);
    } finally {
      setBusy(false);
    }
  });
  const discard = () => { edited.discard(); boardEdit.discard(); };
  const blocked = (boardCount ? boardBlocked(boardEdit.value) : null) ?? (settings.name.trim() ? null : 'The project needs a name.');
  const note = renaming
    ? 'saving renames the project; its sessions, manager and questions stay with it, and its folder is not moved'
    : 'running sessions keep theirs; new and resumed ones get these';
  return (
    <SettingsSplit groups={PROJECT_GROUPS} current={group} words={words} marked={marked} narrow={narrow}
      onOpen={(g) => onOpen(g === null ? `ps:${project.name}` : tabGroupView(project.name, g))}
      foot={<SaveBar count={count} saved={justSaved} busy={busy} note={note} disabled={blocked} onSave={() => void save()} onDiscard={discard} />}>
      {group === 'general' && (
        <section>
          <h3>General</h3>
          <p className="muted mono tab-where">{project.where}</p>
          <div className="form">
            <NameField {...f} />
            <AccountField {...f} accounts={accounts} container={container} />
            <ModelFields {...f} />
            <ModeField {...f} />
            {!container && <ExtraFoldersField {...f} />}
            <ProjectUsagePublish value={settings} onChange={f.onChange} />
          </div>
        </section>
      )}
      {group === 'safety' && (
        <section>
          <h3>What always goes to you</h3>
          <div className="safety">
            <SensitiveList value={settings} onChange={f.onChange} heading={false} />
          </div>
        </section>
      )}
      {group === 'powers' && (
        <section>
          <h3>Manager's powers</h3>
          <div className="form">
            <GrantField {...f} />
            <ToolSwitches {...f} />
            <DevShipField {...f} />
            <LockdownChoice value={settings} onChange={f.onChange} levelB={lockdownB} container={container} />
          </div>
        </section>
      )}
      {group === 'skills' && (
        <section>
          <h3>Skills &amp; profiles</h3>
          <div className="form">
            <ProjectSkills {...f} project={project.name} />
            <ProfileChoice {...f} role="manager" profiles={profiles} />
            <ProfileChoice {...f} role="session" profiles={profiles} />
          </div>
        </section>
      )}
      {group === 'look' && (
        <section>
          <h3>Look</h3>
          <p className="muted">The names of its manager and its sessions in the sidebar and their headers. Saved at once, for every browser.</p>
          <NameColourPickers project={project} run={run} />
        </section>
      )}
      {group === 'workflow' && (
        <section>
          <h3>Workflow</h3>
          {workflow?.workflows.length
            ? <div className="form"><WorkflowFields {...f} workflow={workflow} container={container} /></div>
            : <p><span className="field-name">Workflow</span>: <span className="muted">{workflow ? 'none is configured in Ledung\'s config ("workflow" or "workflows").' : 'looking…'}</span></p>}
          {project.runner === 'local' && <WorkflowNotice check={workflow} settings={settings} container={false} />}
        </section>
      )}
      {group === 'tickets' && (
        <section>
          <h3>Tickets &amp; questions</h3>
          <div className="form">
            <TicketFields {...f} />
            <TiersField {...f} />
          </div>
        </section>
      )}
      {group === 'board' && (
        <section>
          <h3>Message board</h3>
          <ProjectBoard board={board} project={project.name} projects={projects} form={boardEdit.value} onChange={(b) => { boardEdit.set(b); setJustSaved(false); }} />
        </section>
      )}
      {group === 'remove' && (
        <section>
          <h3>Remove project</h3>
          <p className="muted">Takes the project off the list and stops its sessions. Their history stays, and the folder is not touched.</p>
          {confirming ? (
            <span className="restart-confirm">
              <button className="small primary" onClick={() => void run(async () => { await api.removeProject(project.name); onRemoved(); })}>Remove {project.name}</button>
              <button className="small" onClick={() => setConfirming(false)}>Cancel</button>
            </span>
          ) : <button onClick={() => setConfirming(true)}>Remove project…</button>}
        </section>
      )}
    </SettingsSplit>
  );
}

/** A project whose manager hasn't started yet: writing to it starts it. */
export function ProjectStartView({ project, run, onStarted }: { project: ProjectInfo; run: Run; onStarted: (id: string) => void }) {
  const typing = usePlainTyping();
  const [text, setText] = useState('');
  return (
    <LockdownFrame level={frameLevel(project)} fill>
      <div className="page-view">
        <header className="session-head"><div className="session-head-text"><h2>{project.name}</h2>
          <div className="muted mono">{project.where}</div></div></header>
        <div className="page-body">
          <p>This project's manager hasn't started yet. Write to it and it starts: give it a task, or ask where things stand.</p>
          <div className="composer">
            <textarea {...typing} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message the manager of ${project.name}`} />
            <button className="primary" disabled={!text.trim()} onClick={() => void run(async () => onStarted((await api.messageManager(project.name, text)).id))}>Start manager</button>
          </div>
        </div>
      </div>
    </LockdownFrame>
  );
}
