// The usage page (step 5), in two tabs (issue #362, Martin's answer to Ledung question #310): This computer, with
// filters in one row, a few headline figures, daily bars, the project × model matrix with roles, and recent sessions,
// modelled on Simon's own usage dashboard; and Shared, everyone's published usage (SharedUsage.tsx). A third tab,
// Sessions, is the old Overview's list of live sessions (issue #400, Ledung question #393); it has its own address, so
// the old Overview address, bookmarks and Back land on it.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { projectLabel, type MachineInfo, type Overview, type SessionInfo, type UsageFilter, type UsagePeriod, type UsageReport } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { formatTime } from '../components/MessageList.tsx';
import { colorMap, formatCost, formatTokens, Legend, pct, StackedBars, Tile, TRIGGER_LABEL, TRIGGERS } from './charts.tsx';
import { TypicalCosts } from './MachinePanel.tsx';
import { SessionsTab } from './SessionsTab.tsx';
import { SharedUsage } from './SharedUsage.tsx';

const PERIODS: [UsagePeriod, string][] = [['week', 'Since weekly reset'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['all', 'All time']];
type Split = 'model' | 'project' | 'trigger';

function shortDay(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric' });
}

type Tab = 'computer' | 'shared' | 'sessions';
const TABS: [Tab, string][] = [['computer', 'This computer'], ['shared', 'Shared'], ['sessions', 'Sessions']];

export function UsageView(props: {
  /** Sessions is open: the page's own view ("overview"), not this component's state, so its address works. */
  sessionsOpen: boolean;
  /** Opens Usage on Sessions (true) or on one of the other tabs (false). */
  onSessions: (open: boolean) => void;
  sessions: SessionInfo[];
  overview: Overview | null;
  machine: MachineInfo | null;
  waitingBySession: Record<string, number>;
  onOpenSession: (id: string) => void;
}) {
  const [other, setOther] = useState<Exclude<Tab, 'sessions'>>('computer');
  const tab: Tab = props.sessionsOpen ? 'sessions' : other;
  const choose = (key: Tab) => {
    if (key === 'sessions') {
      if (!props.sessionsOpen) props.onSessions(true);
      return;
    }
    setOther(key);
    if (props.sessionsOpen) props.onSessions(false);
  };
  return (
    <div className="usage">
      <header className="session-head">
        <div className="session-head-text"><h2>Usage</h2></div>
      </header>
      <div className="pane-tabs" role="tablist" aria-label="Usage">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => choose(key)}>{label}</button>
        ))}
      </div>
      {tab === 'computer' ? <ComputerUsage onOpenSession={props.onOpenSession} />
        : tab === 'shared' ? <SharedUsage />
          : <SessionsTab sessions={props.sessions} overview={props.overview} machine={props.machine} waitingBySession={props.waitingBySession} onOpenSession={props.onOpenSession} />}
    </div>
  );
}

/** The This computer tab: this Ledung's own usage. */
function ComputerUsage({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [filter, setFilter] = useState<UsageFilter>({ period: 'week' });
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState<Split>('model');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let current = true;
    api.usage(filter).then((r) => current && setReport(r), (e: Error) => current && setError(e.message));
    const timer = setInterval(() => api.usage(filter).then((r) => current && setReport(r), () => {}), 30000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [filter]);

  const colors = useMemo(() => ({
    model: colorMap('model', report?.options.models ?? []),
    project: colorMap('project', report?.options.projects ?? []),
    trigger: colorMap('trigger', TRIGGERS),
  }), [report?.options.models, report?.options.projects]);

  if (error) return <div className="usage-body"><p className="error">{error}</p></div>;
  if (!report) return <div className="usage-body"><p className="muted">Loading…</p></div>;

  const set = (patch: Partial<UsageFilter>) => setFilter((f) => ({ ...f, ...patch }));
  const t = report.totals;
  const seriesKeys =
    split === 'model' ? report.models
      : split === 'project' ? [...new Set(report.daily.flatMap((d) => Object.keys(d.byProject)))].sort()
        : TRIGGERS.filter((k) => report.daily.some((d) => d.byTrigger[k]));
  const series = seriesKeys.map((k) => ({
    key: k,
    label: split === 'trigger' ? TRIGGER_LABEL[k] ?? k : k,
    color: colors[split](k),
  }));
  const columns = report.daily.map((d) => ({
    label: new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }),
    short: shortDay(d.day),
    values: split === 'model' ? d.byModel : split === 'project' ? d.byProject : d.byTrigger,
  }));
  const anyFilter = filter.project || filter.model || filter.branch || filter.role || filter.trigger || filter.account;

  return (
    <div className="usage-body">
      <div className="muted">Since {new Date(report.since || Date.now()).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}{report.since === 0 ? ' (all time)' : ''}</div>
      <div className="filters">
        <label>Period <select value={filter.period} onChange={(e) => set({ period: e.target.value as UsagePeriod })}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label>Project <select value={filter.project ?? ''} onChange={(e) => set({ project: e.target.value || undefined })}><option value="">All</option>{report.options.projects.map((p) => <option key={p} value={p}>{projectLabel(p)}</option>)}</select></label>
        {(report.options.accounts?.length ?? 0) > 1 && (
          <label>Account <select value={filter.account ?? ''} onChange={(e) => set({ account: e.target.value || undefined })}><option value="">All</option>{report.options.accounts.map((a) => <option key={a}>{a}</option>)}</select></label>
        )}
        <label>Model <select value={filter.model ?? ''} onChange={(e) => set({ model: e.target.value || undefined })}><option value="">All</option>{report.options.models.map((m) => <option key={m}>{m}</option>)}</select></label>
        <label>Branch <select value={filter.branch ?? ''} onChange={(e) => set({ branch: e.target.value || undefined })}><option value="">All</option>{report.options.branches.map((b) => <option key={b}>{b}</option>)}</select></label>
        <label>Role <select value={filter.role ?? ''} onChange={(e) => set({ role: e.target.value || undefined })}><option value="">All</option><option value="manager">Managers</option><option value="session">Sessions</option></select></label>
        <label>Started by <select value={filter.trigger ?? ''} onChange={(e) => set({ trigger: e.target.value || undefined })}><option value="">All</option>{TRIGGERS.map((k) => <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>)}</select></label>
        {anyFilter && <button className="small" onClick={() => setFilter({ period: filter.period })}>Clear filters</button>}
      </div>

      <div className="tiles">
        <Tile label="Tokens" value={formatTokens(t.tokens)} sub={`${formatTokens(t.output)} output`} />
        <Tile label="API-equivalent cost" value={formatCost(t.cost)} sub="not what a plan charges" />
        <Tile label="Model calls" value={t.calls.toLocaleString()} sub={`${t.sessions} session${t.sessions === 1 ? '' : 's'}`} />
        <Tile label="Cache read share" value={t.tokens ? pct(t.cacheRead / t.tokens) : '—'} sub="higher is cheaper" />
        <Tile label="In subagents" value={t.tokens ? pct(t.subagentTokens / t.tokens) : '—'} />
      </div>

      <section className="card viz-card">
        <div className="viz-card-head">
          <h3>Daily tokens</h3>
          <div className="seg-control" role="group" aria-label="Split by">
            {(['model', 'project', 'trigger'] as Split[]).map((s) => (
              <button key={s} className={split === s ? 'on' : ''} onClick={() => setSplit(s)}>
                {s === 'trigger' ? 'started by' : `by ${s}`}
              </button>
            ))}
          </div>
        </div>
        <Legend items={series} />
        <StackedBars columns={columns} series={series} />
      </section>

      <section className="card viz-card">
        <h3>Project × model</h3>
        <div className="table-scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th>Project</th>
                {report.models.map((m) => <th key={m} className="num"><span className="viz-swatch" style={{ background: colors.model(m) }} /> {m}</th>)}
                <th className="num">Total</th>
                <th className="num">Cost</th>
                <th className="num" title="Share of tokens used by subagents">Sub</th>
              </tr>
            </thead>
            <tbody>
              {report.matrix.map((row) => (
                <Fragment key={row.project}>
                  <tr className="matrix-row">
                    <td>
                      {row.roles.length > 1 && (
                        <button className="caret" aria-label="Show roles" onClick={() => setOpen((o) => ({ ...o, [row.project]: !o[row.project] }))}>
                          {open[row.project] ? '▾' : '▸'}
                        </button>
                      )}
                      <button className="link" onClick={() => set({ project: row.project })}>{projectLabel(row.project)}</button>
                    </td>
                    {report.models.map((m) => <td key={m} className="num">{row.byModel[m] ? formatTokens(row.byModel[m]!) : ''}</td>)}
                    <td className="num strong">{formatTokens(row.tokens)}</td>
                    <td className="num">{formatCost(row.cost)}</td>
                    <td className="num muted">{row.subagentShare ? pct(row.subagentShare) : ''}</td>
                  </tr>
                  {open[row.project] && row.roles.map((r) => (
                    <tr key={r.role} className="matrix-sub">
                      <td>↳ {r.role === 'manager' ? 'managers' : 'sessions'}</td>
                      {report.models.map((m) => <td key={m} className="num">{r.byModel[m] ? formatTokens(r.byModel[m]!) : ''}</td>)}
                      <td className="num">{formatTokens(r.tokens)}</td>
                      <td className="num">{formatCost(r.cost)}</td>
                      <td className="num muted">{r.subagentShare ? pct(r.subagentShare) : ''}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card viz-card">
        <h3>Recent sessions</h3>
        <div className="table-scroll">
          <table className="plain">
            <thead>
              <tr>
                <th>Last call</th><th>Session</th><th>Project</th><th>Branch</th><th>Models</th>
                <th className="num">Calls</th><th className="num">Tokens</th><th className="num">Cost</th><th className="num">Sub</th>
              </tr>
            </thead>
            <tbody>
              {report.recent.map((s) => (
                <tr key={s.sessionId}>
                  <td className="nowrap">{formatTime(s.lastAt)}</td>
                  <td><button className="link" onClick={() => onOpenSession(s.sessionId)}>{s.role === 'manager' ? 'Manager · ' : ''}{s.title}</button></td>
                  <td>{projectLabel(s.project)}</td>
                  <td className="muted">{s.branch ?? ''}</td>
                  <td className="muted">{s.models.join(', ')}</td>
                  <td className="num">{s.calls}</td>
                  <td className="num">{formatTokens(s.tokens)}</td>
                  <td className="num">{formatCost(s.cost)}</td>
                  <td className="num muted">{s.subagentShare ? pct(s.subagentShare) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <TypicalCosts />
    </div>
  );
}
