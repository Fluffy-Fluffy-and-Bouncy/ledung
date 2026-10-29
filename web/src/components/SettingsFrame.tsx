// Settings' frame (issue #365, mockup F): the header with the running version, its update state and Restart Ledung on
// every tab, and the tabs along the top: Ledung, Chats, one per project, Add project. Each tab but Add project is a side
// menu of groups and one group on screen (SettingsSplit; the Chats and project tabs since #366). Above every side menu,
// a search box that finds a setting on any tab (#367).
import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { ProjectInfo, SourceOffer, UpdateView } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { settingsTabs, tabOf, updateWord, type SettingsGroup } from '../settingsGroups.ts';
import { normalize, searchSettings, type SettingHit } from '../settingsSearch.ts';
import { usePlainTyping } from '../usePlainTyping.ts';

export type UpdateState = {
  view: UpdateView | null;
  error: string | null;
  /** Runs a check or an update and shows the state it returns. */
  act: (call: () => Promise<UpdateView>) => void;
};

/**
 * Update Ledung's state (#100), for the header and the Update & restart group. Asked for once Settings opens, every
 * second while a check or an update runs, and again once Ledung is back (a new hello).
 */
export function useUpdateState(hellos: number): UpdateState {
  const [view, setView] = useState<UpdateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.updateStatus().then(setView, (e: Error) => setError(e.message));
  }, [hellos]);
  const busy = !!view && (view.checking || view.updating || view.restarting);
  useEffect(() => {
    if (!busy) return;
    // While restarting, Ledung is away for a moment; the next hello fetches the state again.
    const timer = setInterval(() => api.updateStatus().then(setView, () => {}), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  const act = (call: () => Promise<UpdateView>) => {
    setError(null);
    call().then(setView, (e: Error) => setError(e.message));
  };
  return { view, error, act };
}

/** Whether the page is as narrow as a phone's (the sidebar's own query), following the window as it changes. */
export function useNarrow(query: string): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query);
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

export function SettingsFrame(props: {
  view: string;
  projects: ProjectInfo[];
  source: SourceOffer | null;
  canRestart: boolean;
  hellos: number;
  onOpen: (id: string) => void;
  children: (update: UpdateState) => ReactNode;
}) {
  const update = useUpdateState(props.hellos);
  const word = updateWord(update.view);
  const current = tabOf(props.view);
  const behind = !!update.view?.check && !update.view.check.upToDate;
  const search = useSearch(current, props.projects, (view) => { if (view !== props.view) props.onOpen(view); });
  return (
    <SearchContext.Provider value={search}>
    <div className="page-view settings-frame">
      <header className="session-head settings-head">
        <div className="session-head-text"><h2>Settings</h2>
          <div className="muted">One place for Ledung, chats and every project.</div></div>
        <div className="session-corner settings-version">
          <span className={`settings-state${behind ? ' behind' : word === 'up to date' ? ' ok' : ''}`} title={props.source ? `Running ${props.source.version}` : undefined}>
            Ledung {props.source?.version ?? ''}{word && <> · {word}</>}
          </span>
          {props.canRestart
            ? <RestartButton hellos={props.hellos} />
            : <span className="muted" title="This Ledung was started by an older launcher. Restart it once from its console window (Ctrl+C, then Ledung.cmd).">Restart: from console</span>}
        </div>
      </header>
      <nav className="settings-tabs" role="tablist" aria-label="Settings">
        {settingsTabs(props.projects).map((t) => (
          <button key={t.id} role="tab" aria-selected={current === t.id} className={`settings-tab${current === t.id ? ' on' : ''}${t.id === 'add' ? ' add' : ''}`}
            onClick={() => { if (current !== t.id || props.view !== t.view) props.onOpen(t.view); }}>{t.label}</button>
        ))}
      </nav>
      <div className="settings-tab-body">{props.children(update)}</div>
    </div>
    </SearchContext.Provider>
  );
}

/** A setting chosen from the search: its tab's split highlights it once its group is on screen. */
type Target = { tab: string; group: string; label: string; n: number };

/** The search in Settings (issue #367): kept by the frame, so it stays as tabs change; drawn by each tab's split. */
type Search = {
  query: string;
  setQuery: (q: string) => void;
  hits: SettingHit[];
  choose: (hit: SettingHit) => void;
  input: RefObject<HTMLInputElement | null>;
  /** The tab on screen, as tabOf gives it. */
  tab: string | null;
  target: Target | null;
  /** The target was highlighted, or could not be found. */
  reached: (n: number) => void;
};

const SearchContext = createContext<Search | null>(null);

/** Whether a key press goes into something being typed in, where "/" is a character. */
const typingIn = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

function useSearch(tab: string | null, projects: ProjectInfo[], open: (view: string) => void): Search {
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<Target | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const hits = useMemo(() => searchSettings(query, projects, tab), [query, projects, tab]);
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    // Captured on the document, before App's listener, which leaves Settings on Escape: a search is cleared first.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key === 'Escape' && queryRef.current) {
        e.preventDefault();
        setQuery('');
        input.current?.focus();
      } else if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typingIn(e.target) && input.current) {
        e.preventDefault();
        input.current.focus();
        input.current.select();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  return {
    query, setQuery, hits, input, tab, target,
    choose: (hit) => {
      setQuery('');
      setTarget({ tab: hit.tab, group: hit.group, label: hit.label, n: Date.now() });
      open(hit.view);
    },
    reached: (n) => setTarget((t) => (t?.n === n ? null : t)),
  };
}

/** Where a setting's label is drawn in a group: the same places the browser check reads (test/loopback/settings-frame.ts). */
const LABELS = 'section h3, section h4, label.toggle, .compact-slider > span, .offline-name, .field-name';

/** The block to highlight for a setting: its row, field or switch, found by its label as drawn. */
function findSetting(content: HTMLElement | null, label: string): HTMLElement | null {
  if (!content) return null;
  const want = normalize(label);
  // A feature that is off may be drawn as "Run a <label>" (Relay), as the browser check also accepts.
  const el = [...content.querySelectorAll<HTMLElement>(LABELS)].find((e) => { const t = normalize(e.textContent ?? ''); return t === want || t === `run a ${want}`; });
  // A whole field or one-line feature first: a field's name sits in its own label, which is nearer.
  return el ? el.closest<HTMLElement>('.field, .offline') ?? el.closest<HTMLElement>('label, details, .compact-slider') ?? el : null;
}

/** How long a chosen setting stays highlighted, and how long its group may take to draw it. */
const HIGHLIGHT_MS = 2500;
const FIND_MS = 2000;

/** The search box above a tab's side menu: "/" focuses it, Escape clears it, Enter opens the first hit. */
function SearchBox({ search }: { search: Search }) {
  const typing = usePlainTyping();
  return (
    <div className="settings-search">
      <span className="settings-search-icon" aria-hidden>⌕</span>
      <input ref={search.input} type="search" placeholder="Search settings" aria-label="Search settings" value={search.query} {...typing}
        onChange={(e) => search.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && search.hits[0]) { e.preventDefault(); search.choose(search.hits[0]); }
          if (e.key === 'ArrowDown') { e.preventDefault(); document.querySelector<HTMLElement>('.search-results button')?.focus(); }
        }} />
      {/* Clears the search and keeps the focus in the box (issue #383, Martin 2026-10-28 14:34). */}
      {search.query
        ? <button type="button" className="settings-search-clear" aria-label="Clear search" title="Clear search" onClick={() => { search.setQuery(''); search.input.current?.focus(); }}>×</button>
        : <kbd>/</kbd>}
    </div>
  );
}

/** What the search found, each with its tab and group; or that nothing matches. */
function SearchResults({ search }: { search: Search }) {
  const q = search.query.trim();
  if (!search.hits.length) {
    return (
      <div className="search-results" role="region" aria-label="Search results">
        <p className="muted">No setting matches "{q}".</p>
      </div>
    );
  }
  return (
    <div className="search-results" role="region" aria-label="Search results">
      <p className="muted">{search.hits.length} setting{search.hits.length === 1 ? '' : 's'} match "{q}"</p>
      <ul>
        {search.hits.map((h) => (
          <li key={`${h.tab}/${h.group}/${h.label}`}>
            <button className="search-hit" onClick={() => search.choose(h)}
              onKeyDown={(e) => {
                const li = e.currentTarget.parentElement;
                const to = e.key === 'ArrowDown' ? li?.nextElementSibling : e.key === 'ArrowUp' ? li?.previousElementSibling : undefined;
                if (to === undefined) return;
                e.preventDefault();
                if (to) to.querySelector('button')?.focus();
                else if (e.key === 'ArrowUp') search.input.current?.focus();
              }}>
              <span className="search-hit-name">{h.label}{h.storedIn && <> <Where kind={h.storedIn} /></>}</span>
              <span className="search-hit-path">{h.tabLabel} › {h.groupLabel}</span>
              {h.about && <span className="search-hit-about muted">{h.about}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How long a restart may take before the page says it didn't come back. */
const RESTART_TIMEOUT_MS = 60_000;

/** Restart Ledung; "Restarting…" until Ledung is back on the live connection (a new hello). */
export function RestartButton({ hellos }: { hellos: number }) {
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<'idle' | 'restarting' | 'failed' | 'timeout'>('idle');
  const [pressedAt, setPressedAt] = useState(0);
  useEffect(() => {
    if (state === 'restarting' && hellos > pressedAt) setState('idle');
  }, [state, hellos, pressedAt]);
  useEffect(() => {
    if (state !== 'restarting') return;
    const timer = setTimeout(() => setState('timeout'), RESTART_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [state]);
  if (state === 'restarting') return <span className="muted">Restarting…</span>;
  if (!confirming) {
    return (
      <span className="restart-confirm">
        {state === 'failed' && <span className="restart-problem">The restart was refused.</span>}
        {state === 'timeout' && <span className="restart-problem">Ledung hasn't come back yet. Check its console window.</span>}
        <button className="small" title="Restart Ledung on its newest version" onClick={() => { setState('idle'); setConfirming(true); }}>
          Restart Ledung
        </button>
      </span>
    );
  }
  return (
    <span className="restart-confirm">
      <span className="muted">Sessions keep running and reconnect.</span>
      <button
        className="small primary"
        onClick={async () => {
          setPressedAt(hellos);
          setConfirming(false);
          setState('restarting');
          try {
            await api.restart();
          } catch {
            setState('failed');
            setConfirming(false);
          }
        }}
      >
        Restart
      </button>
      <button className="small" onClick={() => setConfirming(false)}>Cancel</button>
    </span>
  );
}

/** Where a setting is kept, next to its name: "this browser" or "config" (issue #365); the server's own carry none. */
export function Where({ kind }: { kind: 'browser' | 'config' }) {
  return <span className={`where ${kind}`} title={kind === 'browser' ? 'Kept in this browser only: another browser or device has its own' : "Read from Ledung's config file"}>{kind === 'browser' ? 'this browser' : 'config'}</span>;
}

/**
 * A tab's side menu and its one group on screen (issue #365; the project and Chats tabs share it since #366). On a
 * phone (`current` null) the menu is the whole page and a group opens on its own with "← All settings". `words` sit
 * beside a group's name ("off", a count); `marked` groups have unsaved changes. `foot` is drawn under the group, such
 * as a tab's Save bar.
 */
export function SettingsSplit(props: {
  groups: SettingsGroup[];
  current: string | null;
  words: Record<string, string>;
  marked?: Set<string>;
  narrow: boolean;
  /** A group, or null for the list of groups (the phone's "← All settings"). */
  onOpen: (group: string | null) => void;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const search = useContext(SearchContext);
  const searching = !!search?.query.trim();
  const content = useRef<HTMLDivElement>(null);
  // A setting chosen from the search (#367): once its tab and group are on screen, find it (a group may draw it a
  // moment later, once its data is in), scroll to it and highlight it for a while.
  const target = search?.target;
  const here = !!target && target.tab === search.tab && target.group === props.current && !searching;
  useEffect(() => {
    if (!here || !target || !search) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      const el = findSetting(content.current, target.label);
      if (!el) {
        if (Date.now() - started < FIND_MS) timer = setTimeout(look, 100);
        else search.reached(target.n);
        return;
      }
      el.classList.add('search-found');
      el.scrollIntoView({ block: 'center' });
      setTimeout(() => el.classList.remove('search-found'), HIGHLIGHT_MS);
      search.reached(target.n);
    };
    look();
    return () => clearTimeout(timer);
  }, [here, target?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const side = (
    <div className="settings-side">
      {search && <SearchBox search={search} />}
      {searching && props.current === null ? <SearchResults search={search!} /> : <SettingsMenu {...props} />}
    </div>
  );
  if (props.current === null) return <div className="settings-split narrow">{side}{props.foot}</div>;
  const label = props.groups.find((g) => g.id === props.current)?.label ?? '';
  return (
    <div className={`settings-split${props.narrow ? ' narrow' : ''}`}>
      {!props.narrow && side}
      <div className="settings-main">
        {searching && !props.narrow && <SearchResults search={search!} />}
        {/* Hidden, not gone, while the results show: what is typed in the group stays. */}
        <div className="settings-content" role="region" aria-label={label} ref={content} hidden={searching && !props.narrow}>
          {props.narrow && (
            <div className="settings-group-head">
              <button className="small" onClick={() => props.onOpen(null)}>← All settings</button>
              <h3>{label}</h3>
            </div>
          )}
          {props.children}
        </div>
        {props.foot}
      </div>
    </div>
  );
}

/** The side menu: the groups in order, a line between parts, "This browser" over its own; a word such as "off" beside some. */
function SettingsMenu(props: { groups: SettingsGroup[]; current: string | null; words: Record<string, string>; marked?: Set<string>; narrow: boolean; onOpen: (group: string) => void }) {
  return (
    <nav className="settings-menu" aria-label="Settings groups">
      {props.groups.map((g, i) => {
        const first = i > 0 && props.groups[i - 1]!.part !== g.part;
        const marked = props.marked?.has(g.id);
        return (
          <Fragment key={g.id}>
            {first && <div className="settings-menu-sep" />}
            {first && g.part === 'browser' && <div className="settings-menu-cap">This browser</div>}
            <button className={`settings-menu-item${props.current === g.id ? ' on' : ''}${g.id === 'remove' ? ' danger' : ''}`} aria-current={props.current === g.id ? 'page' : undefined} onClick={() => props.onOpen(g.id)}>
              <span>{g.label}{marked && <span className="unsaved-mark" title="Changed, not saved yet" aria-label="(not saved)"> •</span>}</span>
              <span className="muted">{props.words[g.id] ?? ''}{props.narrow && ' ›'}</span>
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

/**
 * A tab's one Save bar (issue #366, mockup E): the count of unsaved changes, Discard and Save. Shown while something is
 * changed, and for a moment after a save.
 */
export function SaveBar(props: { count: number; saved: boolean; busy: boolean; note: string; disabled?: string | null; onSave: () => void; onDiscard: () => void }) {
  if (!props.count && !props.saved) return null;
  return (
    <div className="save-bar" role="region" aria-label="Unsaved changes">
      <span className="muted">
        {props.count ? `${props.count} unsaved change${props.count === 1 ? '' : 's'}` : 'Saved.'}
        {props.count > 0 && <> · {props.note}</>}
        {props.count > 0 && props.disabled && <> · <span className="error">{props.disabled}</span></>}
      </span>
      <span className="grow" />
      {props.count > 0 && <button className="small" disabled={props.busy} onClick={props.onDiscard}>Discard</button>}
      {props.count > 0 && <button className="small primary" disabled={props.busy || !!props.disabled} onClick={props.onSave}>{props.busy ? 'Saving…' : 'Save'}</button>}
    </div>
  );
}

/**
 * Under a field's name (issue #366): "Ledung default: X" while it follows Ledung, or "Overrides Ledung (X) · Reset"
 * once it has its own value; Reset puts the default back (saved with the tab's Save).
 */
export function InheritLine({ follows, text, onReset }: { follows: boolean; text: string; onReset: () => void }) {
  return (
    <span className={`inherit${follows ? '' : ' over'}`}>
      {text}
      {!follows && <> · <button type="button" className="link" onClick={(e) => { e.preventDefault(); onReset(); }}>Reset</button></>}
    </span>
  );
}
