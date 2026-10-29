// The Usage page's Shared tab (issue #364): everyone who publishes to the shared usage repo (#363). Limit cards per
// account with each bar split by computer, one daily chart stackable by person, account, computer, model or project,
// and who's who. Mine limits it all to the signed-in login's own computers: the hivemind view (#310).
import { useEffect, useMemo, useState } from 'react';
import type { UsagePeriod } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { colorMap, formatCost, formatTokens, Legend, pct, StackedBars } from './charts.tsx';
import { readingAge, shownAge } from './readingAge.ts';
import { accountCards, dailyStack, periodStart, viewerLogin, visibleFiles, whosWho, type AccountCard, type StackBy } from './sharedModel.ts';
import type { SharedUsageView } from '../../../src/shared/published-usage.ts';

const PERIODS: [UsagePeriod, string][] = [['week', 'Since weekly reset'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['all', 'All time']];
const STACKS: [StackBy, string][] = [['person', 'person'], ['account', 'account'], ['computer', 'computer'], ['model', 'model'], ['project', 'project']];
const LIMIT_LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet' };
const STATUS: Record<string, { cls: string; icon: string; label: string }> = {
  allowed: { cls: 'good', icon: '●', label: 'OK' }, allowed_warning: { cls: 'warning', icon: '▲', label: 'Close to the limit' }, rejected: { cls: 'critical', icon: '■', label: 'Limit reached' },
};

/** A table entry by its own key only: limit kinds and statuses come from other people's files, so "__proto__" must not reach Object.prototype (review of PR #372, finding 1). */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Reads the shared view every minute; the server polls GitHub and only sends what it has. */
export function SharedTab() {
  const [view, setView] = useState<SharedUsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const read = () => api.sharedUsage().then((v) => current && (setView(v), setError(null)), (e: Error) => current && setError(e.message));
    read();
    const timer = setInterval(read, 60_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, []);
  if (error && !view) return <p className="error">{error}</p>;
  if (!view) return <p className="muted">Loading…</p>;
  return <SharedView view={view} now={Date.now()} />;
}

export function SharedView({ view, now, initialMine = false }: { view: SharedUsageView; now: number; initialMine?: boolean }) {
  const [mine, setMine] = useState(initialMine);
  const [period, setPeriod] = useState<UsagePeriod>('week');
  const [by, setBy] = useState<StackBy>('person');
  const login = viewerLogin(view);
  const files = useMemo(() => visibleFiles(view, mine), [view, mine]);
  const from = periodStart(period, files, now);
  const cards = useMemo(() => accountCards(files, now), [files, now]);
  const daily = useMemo(() => dailyStack(files, by, from, now), [files, by, from, now]);
  const who = useMemo(() => whosWho(files, from, now), [files, from, now]);
  const computerColor = colorMap('project', [...new Set(visibleFiles(view, false).map((f) => f.computerId))]);
  const stackColor = colorMap(by === 'model' ? 'model' : 'project', daily.keys);

  if (!view.repo) return <p className="muted">Nothing is published here yet. Switch on Publish usage in Settings to share this computer's usage and read everyone else's.</p>;

  const series = daily.keys.map((k) => ({ key: k, label: k, color: stackColor(k) }));
  const columns = daily.columns.map((c) => ({
    label: new Date(`${c.day}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }),
    short: new Date(`${c.day}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric' }),
    values: c.values,
  }));

  return (
    <div className="shared-usage">
      <div className="filters">
        <label>Period <select value={period} onChange={(e) => setPeriod(e.target.value as UsagePeriod)}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="shared-mine" title={login ? `Only ${login}'s own computers` : 'Mine needs this computer to publish its usage too'}>
          <input type="checkbox" checked={mine} disabled={!login} onChange={(e) => setMine(e.target.checked)} /> Mine
        </label>
      </div>
      {view.error && <p className="error">Could not read the shared usage just now: {view.error}{view.entries.length ? ' Showing the last files read.' : ''}</p>}
      {view.entries.filter((e) => e.state !== 'ok' && (!mine || e.login === login)).map((e) => (
        <p key={e.id} className="shared-note warning">
          {e.computer ?? 'A computer'}{e.login ? ` (${e.login})` : ''}
          {e.state === 'newer' ? ' publishes usage in a newer format: update Ledung to see it.' : ` published a usage file Ledung cannot read${e.reason ? ` (${e.reason})` : ''}.`}
        </p>
      ))}
      {!files.length && <p className="muted">{mine ? 'None of your computers has published yet.' : 'No computer has published yet.'}</p>}

      {cards.length > 0 && (
        <div className="shared-cards">
          {cards.map((c) => <AccountLimitCard key={c.fingerprint} card={c} now={now} color={computerColor} />)}
        </div>
      )}

      {files.length > 0 && (
        <section className="card viz-card">
          <div className="viz-card-head">
            <h3>Daily tokens</h3>
            <div className="seg-control shared-stack" role="group" aria-label="Stack by">
              <span className="muted">by</span>
              {STACKS.map(([s, l]) => <button key={s} className={by === s ? 'on' : ''} onClick={() => setBy(s)}>{l}</button>)}
            </div>
          </div>
          <Legend items={series} />
          <StackedBars columns={columns} series={series} />
        </section>
      )}

      {who.length > 0 && (
        <section className="card viz-card">
          <h3>Who's who</h3>
          <div className="table-scroll">
            <table className="plain">
              <thead>
                <tr><th>Person</th><th>Account</th><th>Computer</th><th className="num">Tokens</th><th className="num">Cost</th><th>Last published</th></tr>
              </thead>
              <tbody>
                {who.map((r, i) => {
                  const prev = who[i - 1];
                  const samePerson = prev?.login === r.login;
                  return (
                    <tr key={`${r.computerId}-${r.fingerprint}`} className={r.stale ? 'shared-stale' : ''}>
                      <td>{samePerson ? '' : r.login}</td>
                      <td>{samePerson && prev?.fingerprint === r.fingerprint ? '' : r.account}</td>
                      <td className="nowrap"><span className="viz-swatch" style={{ background: computerColor(r.computerId) }} /> {r.computer}</td>
                      <td className="num">{formatTokens(r.tokens)}</td>
                      <td className="num">{formatCost(r.cost)}</td>
                      <td className="nowrap">
                        {readingAge({ at: r.asOf, resetsAt: null }, now).replace(/^as of /, '')}
                        {r.stale && <span className="shared-stale-mark" title="No publish for over a day"> · stale</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function AccountLimitCard({ card, now, color }: { card: AccountCard; now: number; color: (computerId: string) => string }) {
  return (
    <section className="card viz-card shared-card">
      <h3>{card.label}</h3>
      <div className="muted shared-card-who">{card.people.join(', ')} · {card.computers.length} computer{card.computers.length === 1 ? '' : 's'}</div>
      {!card.rows.some((r) => r.reading) && <div className="muted">no data yet</div>}
      {card.rows.map((r) => {
        const label = own(LIMIT_LABEL, r.kind) ?? r.kind;
        if (!r.reading) return null;
        if (r.reset) {
          return (
            <div key={r.kind} className="shared-limit limit-reset" title={`${label}: the window has reset since the last reading (${readingAge(r.reading, now)}).`}>
              <div className="limit-head"><span>{label}</span><span className="limit-status">reset</span></div>
              <div className="limit-sub muted"><span>no reading since the reset</span></div>
            </div>
          );
        }
        const u = r.reading.utilization;
        const age = shownAge(r.reading, now);
        const filled = Math.min(100, (u ?? 0) * 100);
        const st = own(STATUS, r.reading.status) ?? { cls: 'good', icon: '●', label: r.reading.status };
        const tip = r.shares.map((s) => `${s.computer} (${s.login}): ${pct(s.share)}, ${formatCost(s.cost)}`).join('\n');
        return (
          <div key={r.kind} className="shared-limit">
            <div className="limit-head">
              <span>{label}</span>
              <span className={`limit-status ${st.cls}`} title={st.label}>{st.icon} {u != null ? pct(u) : st.label}</span>
            </div>
            {/* The filled part split by each computer's share of the cost since the window started (issue #364). */}
            <div className="limit-track shared-track" title={tip || 'No use recorded in this window'}>
              <div className="shared-fill" style={{ width: `${filled}%` }}>
                {r.shares.length
                  ? r.shares.map((s) => <div key={s.computerId} className="shared-seg" style={{ flexGrow: s.share, background: color(s.computerId) }} />)
                  : <div className={`shared-seg limit-fill ${st.cls}`} style={{ flexGrow: 1 }} />}
              </div>
            </div>
            <div className="limit-sub muted">
              <span>{r.shares.map((s) => `${s.computer} ${pct(s.share)}`).join(' · ')}</span>
              <span className={`limit-forecast${r.pace != null && r.pace >= 1 ? ' over' : ''}`}>≈ {r.pace != null ? pct(r.pace) : '—'} by reset</span>
            </div>
            {age && <div className="limit-sub limit-age">{age}</div>}
          </div>
        );
      })}
    </section>
  );
}
