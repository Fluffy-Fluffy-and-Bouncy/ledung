// One session's usage (step 5): headline figures, tokens per model call (colour = model, subagent
// calls textured) and the per-call table. Shown in the side panel from the session header.
import { useEffect, useMemo, useState } from 'react';
import type { SessionUsage as Usage } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { SessionTurns } from './MachinePanel.tsx';
import { colorMap, formatCost, formatTokens, Legend, pct, StackedBars, Tile, TRIGGER_LABEL } from './charts.tsx';

export function SessionUsagePanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const load = () => api.sessionUsage(sessionId).then((u) => current && setUsage(u), (e: Error) => current && setError(e.message));
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [sessionId]);

  const color = useMemo(() => colorMap('model', usage?.models ?? []), [usage?.models]);
  const t = usage?.totals;
  // The latest 120 calls fit a chart; the table has them all.
  const shown = usage ? usage.calls.slice(-120) : [];

  return (
    <aside className="file-panel" aria-label="Usage">
      <header className="file-head">
        <span className="file-path">Usage of this session</span>
        <button className="small" onClick={onClose}>Close</button>
      </header>
      <div className="file-body">
        {error && <p className="error">{error}</p>}
        {!usage && !error && <p className="muted">Loading…</p>}
        {usage && t && (
          <>
            <div className="tiles">
              <Tile label="Tokens" value={formatTokens(t.tokens)} sub={`${t.calls} model calls`} />
              <Tile label="API-equivalent cost" value={formatCost(t.cost)} />
              <Tile label="Cache read share" value={t.tokens ? pct(t.cacheRead / t.tokens) : '—'} />
              <Tile label="In subagents" value={t.tokens ? pct(t.subagentTokens / t.tokens) : '—'} />
            </div>
            <h3>Tokens per model call</h3>
            <Legend items={[...usage.models.map((m) => ({ label: m, color: color(m) })), ...(usage.calls.some((c) => c.subagent) ? [{ label: 'subagent call', color: 'var(--s-other)', textured: true }] : [])]} />
            <StackedBars
              height={120}
              columns={shown.map((c) => ({
                label: new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                short: new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                values: { [c.model]: c.tokens },
                textured: !!c.subagent,
                note: [c.compaction ? 'Compaction' : '', c.subagent ? `Subagent: ${c.subagent}` : '', `Started by: ${TRIGGER_LABEL[c.trigger] ?? c.trigger}`].filter(Boolean).join(' · '),
              }))}
              series={usage.models.map((m) => ({ key: m, label: m, color: color(m) }))}
              emptyText="No model calls recorded yet."
            />
            <SessionTurns sessionId={sessionId} />
            <h3>Model calls</h3>
            <div className="table-scroll">
              <table className="plain calls">
                <thead>
                  <tr>
                    <th>Time</th><th>Model</th><th className="num">Input</th><th className="num">Cache write</th><th className="num">Cache read</th>
                    <th className="num">Output</th><th className="num">Thinking</th><th className="num">Tokens</th><th className="num">Cache %</th>
                    <th className="num">Cost</th><th className="num">Running</th><th>Who</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    let running = 0;
                    return usage.calls.map((c, i) => {
                      running += c.cost ?? 0;
                      return (
                        <tr key={i}>
                          <td className="nowrap">{new Date(c.at).toLocaleTimeString()}</td>
                          <td className="nowrap"><span className="viz-swatch" style={{ background: color(c.model) }} /> {c.model}</td>
                          <td className="num">{formatTokens(c.input)}</td>
                          <td className="num">{formatTokens(c.cacheWrite)}</td>
                          <td className="num">{formatTokens(c.cacheRead)}</td>
                          <td className="num">{formatTokens(c.output)}</td>
                          <td className="num muted">{c.thinking ? `~${formatTokens(c.thinking)}` : ''}</td>
                          <td className="num strong">{formatTokens(c.tokens)}</td>
                          <td className="num">{c.tokens ? pct(c.cacheRead / c.tokens) : ''}</td>
                          <td className="num">{formatCost(c.cost)}</td>
                          <td className="num muted">{formatCost(running)}</td>
                          <td className="muted nowrap">{c.subagent ? `subagent: ${c.subagent}` : TRIGGER_LABEL[c.trigger] ?? c.trigger}</td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
