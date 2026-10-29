// Settings behind the sidebar's cog (issue #69): Accounts, Restart Ledung and Add project, which
// used to sit in the sidebar, the notifications switch (#80) and Update Ledung (#100). Accounts and Add project keep
// their own views and addresses. The page's colour scheme (#113). The autocorrect switch (#147) and
// the sidebar's status dot switch (#151). The Compact sidebar slider (#153), with the ship as its handle (#155).
// The switch for the sidebar's "Archived (N)" entry (#157). The tunnel to the relay and paired devices for the public name (#160).
// The computer tabs' names and colours (#240). The session profiles and where each comes from (#298).
// About: the license, Anthropic's software, and the running version with a Source link (AGPL section 13, #332).
// Which Claude Code sessions run, installed or the copy that came with Ledung (#341). Install as app (#350).
// The config file: when it was last read, a refused change and what waits for a restart (#353).
// Since #365 (mockup F, Martin 2026-10-28 in Ledung question #325) this is the Ledung tab inside the Settings frame:
// a side menu of groups, one group on screen at a time, each at its own address; features that are off are one line.
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { BoatSlider } from './BoatSlider.tsx';
import type { AccountChoices, AccountInfoView, BoardStatus, CertificateStatus, ConfigStatus, NewComputerInfo, ProjectInfo, RelayAdminView, RemoteStatus, SessionInfo, SourceOffer, UpdateStepView, UsageStopInfo } from '../../../src/shared/protocol.ts';
import { UsageStopsSettings } from './UsageStopsSettings.tsx';
import { SkillDefaults } from './SkillPicker.tsx';
import { ProfilesSettings } from './ProfilesSettings.tsx';
import { ClaudeCodeSettings } from './ClaudeCodeSettings.tsx';
import { CopyButton } from './Markdown.tsx';
import { certificateLine, remoteLine } from '../remoteStatus.ts';
import { api } from '../api.ts';
import { BoardSettings } from './BoardViews.tsx';
import { UsagePublishSettings } from './UsagePublishSettings.tsx';
import { DevicesSettings } from './DevicesSettings.tsx';
import { LinkedSettings } from './LinkedSettings.tsx';
import { JoinRelay, RelayAdminSettings, relaySetUp } from './RelaySettings.tsx';
import { ComputersSettings } from './ComputersSettings.tsx';
import type { ComputerInfo } from '../../../src/shared/computers.ts';
import { displayVersion } from '../../../src/shared/version.ts';
import type { useNotifications } from '../useNotifications.ts';
import { THEMES, applyTheme, readTheme, saveTheme, type Theme } from '../theme.ts';
import { useAutocorrect } from '../usePlainTyping.ts';
import { useStatusDot } from '../useStatusDot.ts';
import { useCompactSidebar } from '../useCompactSidebar.ts';
import { useArchivedLink } from '../useArchivedLink.ts';
import { COMPACT_STEPS, type CompactStep } from '../compactSidebar.ts';
import { InstallSettings } from './InstallApp.tsx';
import { ShortcutSettings } from './Shortcuts.tsx';
import { AccountsSettings, type DefaultIdentity } from '../projects/AccountsView.tsx';
import { RestartButton, SettingsSplit, Where, useNarrow, type UpdateState } from './SettingsFrame.tsx';
import { LEDUNG_GROUPS, groupOf, groupView, remoteFeatures, remoteWord, tabGroupView, updateTexts, updateWord, type FeatureState } from '../settingsGroups.ts';
import { NARROW_QUERY } from '../sidebarSize.ts';
import { MacrosSettings } from './MacrosSettings.tsx';
import type { Macro } from '../../../src/shared/macros.ts';

export function SettingsView(props: {
  /** The view: "settings", "settings:<group>", or the old "accounts". */
  view: string;
  update: UpdateState;
  accounts: AccountInfoView[];
  accountChoices: AccountChoices;
  defaultIdentity: DefaultIdentity;
  /** Accounts in the config file that could not be added or changed (issue #425). */
  accountProblems: string[];
  usageStops: UsageStopInfo[];
  macros: Macro[];
  board: BoardStatus | null;
  remote: RemoteStatus | null;
  /** The page came through the public name (a phone): this computer's own actions, such as Open folder, are off (issue #414). */
  throughPublicName?: boolean;
  newComputers: NewComputerInfo[];
  projects: ProjectInfo[];
  computers: ComputerInfo[];
  sessions: SessionInfo[];
  run: (action: () => Promise<unknown>) => Promise<void>;
  canRestart: boolean;
  source: SourceOffer | null;
  config: ConfigStatus | null;
  hellos: number;
  notify: ReturnType<typeof useNotifications>;
  onOpen: (id: string) => void;
}) {
  const narrow = useNarrow(NARROW_QUERY);
  const group = groupOf(props.view, narrow);
  const words: Record<string, string> = {
    update: updateWord(props.update.view),
    remote: remoteWord(props.remote),
    notifications: props.notify.possible && !props.notify.on ? 'off' : '',
  };
  return (
    <SettingsSplit groups={LEDUNG_GROUPS} current={group} words={words} narrow={narrow} onOpen={(g) => props.onOpen(g === null ? 'settings' : groupView(g))}>
      {group !== null && <GroupContent group={group} {...props} />}
    </SettingsSplit>
  );
}

type GroupProps = Parameters<typeof SettingsView>[0] & { group: string };

function GroupContent(props: GroupProps) {
  switch (props.group) {
    case 'update': {
      const texts = updateTexts(props.update.view);
      return (
        <>
          <section>
            <h3>Update Ledung</h3>
            {texts.update && <p className="muted">{texts.update}</p>}
            <UpdatePanel update={props.update} />
          </section>
          <section>
            <h3>Restart Ledung</h3>
            <p className="muted">{texts.restart}</p>
            {!!props.config?.restartFor.length && <p className="config-restart">{restartLine(props.config)}</p>}
            {props.canRestart ? (
              <RestartButton hellos={props.hellos} />
            ) : (
              <span className="muted" title="This Ledung was started by an older launcher. Restart it once from its console window (Ctrl+C, then Ledung.cmd).">Restart: from console</span>
            )}
          </section>
          <ShortcutSettings run={props.run} />
        </>
      );
    }
    case 'claude':
      return (
        <>
          <AccountsSettings accounts={props.accounts} choices={props.accountChoices} defaultIdentity={props.defaultIdentity} configFileProblems={props.accountProblems} projects={props.projects} run={props.run} remote={props.throughPublicName} />
          <UsageStopsSettings accounts={props.accounts} usageStops={props.usageStops} run={props.run} />
          <ClaudeCodeSettings sessions={props.sessions} />
          <UsagePublishSettings accounts={props.accounts} run={props.run} />
        </>
      );
    case 'sessions':
      return (
        <>
          <SkillDefaults run={props.run} />
          <ProfilesSettings />
        </>
      );
    case 'macros':
      return <MacrosSettings macros={props.macros} projects={props.projects} run={props.run} />;
    case 'remote':
      return <RemoteGroup {...props} />;
    case 'look':
      return (
        <>
          <section>
            <div className="settings-h"><h3>Appearance</h3><Where kind="browser" /></div>
            <ThemeChoice />
          </section>
          <section>
            <div className="settings-h"><h3>Typing</h3><Where kind="browser" /></div>
            <AutocorrectSwitch />
          </section>
          <section>
            <div className="settings-h"><h3>Sidebar</h3><Where kind="browser" /></div>
            <StatusDotSwitch />
            <ArchivedLinkSwitch />
            <CompactSlider />
          </section>
          <InstallSettings run={props.run} />
        </>
      );
    case 'notifications':
      return (
        <section>
          <div className="settings-h"><h3>Notifications</h3><Where kind="browser" /></div>
          <NotifySwitch notify={props.notify} />
        </section>
      );
    case 'config':
      return props.config ? <ConfigFileSettings config={props.config} /> : <p className="muted">…</p>;
    default:
      return <About source={props.source} />;
  }
}

/** A feature that is off, as one line: its name, one sentence, and Set up (its form) or a button to where it is set up. */
type OffLine = { id: string; name: string; state: FeatureState; why: string; form?: ReactNode; primary?: boolean; go?: { label: string; view: string } };

/**
 * Remote & devices (issue #365): Computers in full, each feature that is on in full, and those that are off as one
 * line each under Not set up, whose Set up opens today's form in its place. Phones and Linked computers need remote
 * access and stay greyed until it is on.
 */
function RemoteGroup(props: GroupProps) {
  // undefined: not read yet; null: refused (through the public name), so Relay stays away.
  const [relay, setRelay] = useState<RelayAdminView | null | undefined>(undefined);
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    api.relayAdmin().then(setRelay, () => setRelay(null));
  }, []);
  const f = remoteFeatures({ remote: props.remote, relaySetUp: relay ? relaySetUp(relay) : null, boardConfigured: !!props.board?.configured });
  const relayForm = relay && <RelayAdminSettings view={relay} onView={setRelay} run={props.run} newComputers={props.newComputers} />;
  const firstProject = props.projects[0]?.name;
  const lines: OffLine[] = [
    { id: 'remote', name: 'Remote access', state: f.remote, why: 'Reach this Ledung from your phone, anywhere, through a relay.', form: <RemoteBody remote={props.remote} />, primary: true },
    { id: 'phones', name: 'Phones', state: f.phones, why: '' },
    { id: 'linked', name: 'Linked computers', state: f.linked, why: '' },
    { id: 'relay', name: 'Run a relay', state: f.relay, why: 'Only if you host a relay for other people.', form: relayForm },
    {
      id: 'board', name: 'Message board', state: f.board,
      why: firstProject ? "Off in every project; turn it on in a project's tab." : 'Off; each project turns it on in its own tab.',
      go: firstProject ? { label: 'Projects ›', view: tabGroupView(firstProject, 'board') } : undefined,
    },
  ];
  const off = lines.filter((l) => l.state === 'off' || l.state === 'needs');
  return (
    <>
      <ComputersSettings computers={props.computers} run={props.run} />
      {f.remote === 'on' && <section><h3>Remote access</h3><RemoteBody remote={props.remote} /></section>}
      {f.phones === 'on' && <DevicesSettings key={props.remote?.publicName ?? 'none'} run={props.run} />}
      {f.linked === 'on' && <LinkedSettings key={`linked-${props.remote?.publicName ?? 'none'}-${props.remote?.tls ?? ''}`} run={props.run} />}
      {f.relay === 'on' && <section><h3>Relay</h3>{relayForm}</section>}
      {f.board === 'on' && <BoardSettings board={props.board} />}
      {off.length > 0 && (
        <section>
          <h3>Not set up</h3>
          {off.map((l) => (opened === l.id && l.state === 'off' && l.form ? (
            <div key={l.id} className="offline-open" role="group" aria-label={l.name}>
              <h4><span>{l.name}</span><button className="small" aria-label={`Close ${l.name}`} title="Close" onClick={() => setOpened(null)}>✕</button></h4>
              {l.form}
            </div>
          ) : (
            <div key={l.id} className={`offline${l.state === 'needs' ? ' needs' : ''}`}>
              <span className="offline-name">{l.name}</span>
              <span className="offline-why">{l.state === 'needs' ? 'Needs remote access first.' : l.why}</span>
              {l.state === 'off' && l.form && <button className={`small${l.primary ? ' primary' : ''}`} onClick={() => setOpened(l.id)}>Set up ›</button>}
              {l.state === 'off' && l.go && <button className="small" onClick={() => props.onOpen(l.go!.view)}>{l.go.label}</button>}
            </div>
          )))}
        </section>
      )}
    </>
  );
}

/** "Restart Ledung to apply: port, lan" (issue #353). */
function restartLine(config: ConfigStatus): string {
  return `Restart Ledung to apply: ${config.restartFor.join(', ')}`;
}

/**
 * The config file (issue #353): Ledung reads it again when it changes, so most settings apply at once, to new and
 * resumed sessions; a file that can't be used is refused and the settings in use stay.
 */
function ConfigFileSettings(props: { config: ConfigStatus }) {
  const c = props.config;
  const at = new Date(c.readAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <section>
      <div className="settings-h"><h3>Config file</h3><Where kind="config" /></div>
      <p className="muted">Ledung reads <code>{c.file}</code> again whenever it changes. Most settings apply at once, to new and resumed sessions; running sessions keep what they started with. A few, such as the port and the network, need Restart Ledung.</p>
      <p>{c.reloaded ? `Last reloaded ${at}.` : `Read at start, ${at}; not changed since.`}</p>
      {c.problem && <p className="config-problem" role="alert">The last change was not applied, the settings in use stay: {c.problem}</p>}
      {!!c.restartFor.length && <p className="config-restart">{restartLine(c)}</p>}
    </section>
  );
}

/**
 * Opt-in browser notifications for what waits for you; only where the browser allows them. Browser
 * notifications, not phone push, so the label doesn't promise push (#80).
 */
function NotifySwitch({ notify }: { notify: ReturnType<typeof useNotifications> }) {
  if (!notify.possible) {
    return <p className="muted">Notifications work when this page is opened on this computer at 127.0.0.1.</p>;
  }
  return (
    <>
      <label className="toggle" title="A browser notification when something new needs your answer and this page is in the background">
        <input type="checkbox" checked={notify.on} onChange={(e) => void notify.set(e.target.checked)} /> Send notifications when an agent is waiting for you
      </label>
      <p className="muted">While a Ledung page is open in this browser.</p>
      {notify.denied && (
        <p className="muted">The browser blocks notifications for this page. Allow them in the browser's site settings (the icon left of the address), then switch this on again.</p>
      )}
    </>
  );
}

/** Autocorrect in the page's text fields, off unless switched on here (#147). */
function AutocorrectSwitch() {
  const [on, set] = useAutocorrect();
  return (
    <>
      <label className="toggle" title="Off: the browser doesn't correct words as you type. Spell checking and automatic capitals are left to the browser either way">
        <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Autocorrect
      </label>
      <p className="muted">Off: words stay as you type them in the message box, answers and every other text field. Spell checking and capitals are the browser's own either way.</p>
    </>
  );
}

/** The status dot on every session row in the sidebar, shown unless switched off here (#151). */
function StatusDotSwitch() {
  const [on, set] = useStatusDot();
  return (
    <>
      <label className="toggle" title="The coloured dot left of each session in the sidebar; the ship shows much the same">
        <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Status dot
      </label>
      <p className="muted">Off: no dot on the session rows; hover a row for its status, and an ended session's name is faded.</p>
    </>
  );
}

/**
 * "Archived (N)" at the end of each project group in the sidebar, shown unless switched off here
 * (#157). Switching it back on is the way back to the archived sessions (Martin, 2026-10-16 23:43).
 */
function ArchivedLinkSwitch() {
  const [on, set] = useArchivedLink();
  return (
    <>
      <label className="toggle" title="The Archived (N) entry under each project in the sidebar, which opens its archived sessions">
        <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> Show "Archived" in the sidebar
      </label>
      <p className="muted">Off: no Archived entry under the projects; switch it back on to open their archived sessions.</p>
    </>
  );
}

/** How compact the sidebar's session cards are, from None to Tightest; the sidebar follows as it is dragged (#153). */
function CompactSlider() {
  const [step, set] = useCompactSidebar();
  const label = COMPACT_STEPS.find((s) => s.step === step)!.label;
  return (
    <>
      <label className="compact-slider" title="Less padding and fewer rows on each session in the sidebar; the ship always stays">
        <span>Compact sidebar</span>
        <BoatSlider step={step} labels={COMPACT_STEPS.map((s) => s.label)} onPick={(n) => set(n as CompactStep)}>
          <input type="range" min={1} max={COMPACT_STEPS.length} step={1} value={step} list="compact-steps"
            aria-valuetext={label} onChange={(e) => set(Number(e.target.value) as CompactStep)} />
        </BoatSlider>
      </label>
      <datalist id="compact-steps">{COMPACT_STEPS.map((s) => <option key={s.step} value={s.step} label={s.label} />)}</datalist>
      <p className="muted">Each step takes more off the session cards: tighter padding and no date and time, then only the name, the ship and the badge, with a small "+" for a new session. Hover a card for what it no longer shows.</p>
    </>
  );
}

/** System, Light or Dark for this page; System follows the computer's setting (#113). */
function ThemeChoice() {
  const [theme, setTheme] = useState<Theme>(() => readTheme(localStorage));
  const choose = (t: Theme) => {
    setTheme(t);
    saveTheme(localStorage, t);
    applyTheme(document.documentElement, t);
  };
  return (
    <>
      <div className="seg-control" role="group" aria-label="Colour scheme">
        {THEMES.map((t) => (
          <button key={t.id} className={theme === t.id ? 'on' : ''} aria-pressed={theme === t.id} onClick={() => choose(t.id)}>{t.label}</button>
        ))}
      </div>
      <p className="muted">System follows the computer's light or dark setting.</p>
    </>
  );
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : 'unknown commit');
const STEP_MARK: Record<UpdateStepView['state'], string> = { waiting: '○', running: '…', done: '✓', failed: '✗' };

/**
 * Update Ledung (#100): Check fetches origin/main in the release's source folder and lists the
 * CHANGELOG bullets since; Update pulls, installs, releases and restarts. The state is the frame's, which the
 * header shows too (issue #365).
 */
function UpdatePanel({ update }: { update: UpdateState }) {
  const { view, error, act } = update;
  const [confirming, setConfirming] = useState(false);
  if (error) return <p className="restart-problem">{error}</p>;
  if (!view) return <p className="muted">…</p>;
  if (view.npm) {
    return (
      <div className="update-panel">
        <p className="muted">Running Ledung <code>{displayVersion(view.npm.version)}</code>, installed from npm.</p>
        <p className="muted">{view.reason}</p>
      </div>
    );
  }
  if (!view.available) return <p className="muted">{view.reason}</p>;
  const busy = view.checking || view.updating || view.restarting;
  const check = view.check;
  const offer = !!check && !check.upToDate && !view.updating && !view.restarting;

  return (
    <div className="update-panel">
      <p className="muted">
        Running {view.running?.commit ? <code>{short(view.running.commit)}</code> : 'an unknown commit (its source is not a git clone)'}, built from <code>{view.running?.source}</code>.
      </p>
      <div className="restart-confirm">
        <button className="small" disabled={busy} onClick={() => { setConfirming(false); act(api.updateCheck); }}>
          {view.checking ? 'Checking…' : 'Check for updates'}
        </button>
        {check && !view.checking && (
          check.upToDate
            ? <span className="update-ok">Up to date ({short(check.latest)})</span>
            : <span>{check.behind} new change{check.behind === 1 ? '' : 's'} on main ({short(check.latest)}){check.commitKnown ? '' : ', counted from the source folder'}</span>
        )}
      </div>
      {view.checkError && <pre className="update-output restart-problem">{view.checkError}</pre>}
      {check && !check.upToDate && check.changes.length > 0 && (
        <ul className="update-changes">{check.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
      )}
      {offer && !view.canRestart && (
        <p className="muted">Updating ends in a restart, and this Ledung was started by an older launcher. Restart it once from its console window first.</p>
      )}
      {offer && view.canRestart && (
        confirming ? (
          <div className="restart-confirm">
            <span className="muted">Pull main, npm install, npm run release, then restart. Sessions keep running.</span>
            <button className="small primary" onClick={() => { setConfirming(false); act(api.update); }}>Update now</button>
            <button className="small" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        ) : (
          <div className="restart-confirm"><button className="small primary" onClick={() => setConfirming(true)}>Update Ledung</button></div>
        )
      )}
      {view.steps.length > 0 && (
        <ol className="update-steps">
          {view.steps.map((s) => (
            <li key={s.label} className={`update-step ${s.state}`}>
              <span className="update-mark">{STEP_MARK[s.state]}</span> {s.label}
              {s.state === 'failed' && s.output && <pre className="update-output">{s.output}</pre>}
            </li>
          ))}
        </ol>
      )}
      {view.refused && <p className="restart-problem">{view.refused}</p>}
      {view.restarting && <p className="muted">The new release is built. Restarting into it…</p>}
    </div>
  );
}

/** Whether phones can reach this Ledung through the relay (issue #160): set in the config, or joined with a code here (#237). */
function RemoteBody(props: { remote: RemoteStatus | null }) {
  const line = remoteLine(props.remote);
  return (
    <>
      <p className={`remote-state ${props.remote?.state ?? 'off'}`}>{line.label}</p>
      {line.detail && <p className="muted">{line.detail}</p>}
      {props.remote?.tls && <p className="remote-tls">{props.remote.tls}</p>}
      {props.remote?.certificate && <CertificateSettings cert={props.remote.certificate} />}
      <JoinRelay remote={props.remote} />
    </>
  );
}

/** Ledung's own certificate by ACME (issue #202): its state, and while it waits, the CAA record to add. */
function CertificateSettings({ cert }: { cert: CertificateStatus }) {
  const line = certificateLine(cert, Date.now());
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const check = () => {
    setChecking(true);
    setProblem(null);
    api.certificateCheck().catch((e) => setProblem((e as Error).message)).finally(() => setChecking(false));
  };
  return (
    <div className="remote-certificate">
      <p className={line.warn ? 'remote-tls' : 'remote-state connected'}>{line.label}</p>
      {line.detail && <p className="muted">{line.detail}</p>}
      {line.copy && cert.accountUrl && (
        <>
          <p className="muted">ACME account ({cert.acme}): <code>{cert.accountUrl}</code> <CopyButton text={cert.accountUrl} /></p>
          {cert.record && <p className="muted">CAA record: <code className="remote-record">{cert.record}</code> <CopyButton text={cert.record} /></p>}
          <div className="restart-confirm"><button className="small" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check now'}</button></div>
        </>
      )}
      {problem && <p className="restart-problem">{problem}</p>}
    </div>
  );
}

/** The license, Anthropic's software, and the source of the running version: AGPL section 13 asks that everyone using it over a network is offered that source (#332). */
function About({ source }: { source: SourceOffer | null }) {
  return (
    <section>
      <h3>About</h3>
      <p className="muted">
        Ledung is free software under the GNU Affero General Public License, version 3, with an additional permission for Anthropic's software; a commercial license is also available.
      </p>
      <p className="muted">
        It runs Anthropic's Claude Agent SDK and Claude Code, installed from npm under <a href="https://code.claude.com/docs/en/legal-and-compliance" target="_blank" rel="noreferrer">Anthropic's own terms</a>. They are not covered by Ledung's license.
      </p>
      {source && (
        <p className="muted">
          Running <code>{source.version}</code>. <a href={source.url} target="_blank" rel="noreferrer">Source</a>
        </p>
      )}
    </section>
  );
}
