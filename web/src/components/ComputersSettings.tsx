// Settings → Computers (issue #240): each computer tab's name and colour, changed here instead of in the config
// file. This Ledung keeps them across restarts; the config's are the starting point and "Use the config's" goes
// back to them. Only this Ledung's tabs change: another computer's Ledung keeps its own.
import { useEffect, useState } from 'react';
import { COMPUTER_COLOURS, COMPUTER_NAME_MAX, type ComputerInfo } from '../../../src/shared/computers.ts';
import { NAME_COLOURS } from '../../../src/shared/name-colours.ts';
import { api } from '../api.ts';
import { Named } from './ProjectName.tsx';
import { usePlainTyping } from '../usePlainTyping.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;

export function ComputersSettings({ computers, run }: { computers: ComputerInfo[]; run: Run }) {
  if (!computers.length) return null;
  return (
    <section>
      <h3>Computers</h3>
      <p className="muted">
        {computers.length > 1
          ? "The tabs at the top of the page, this computer first. A name or colour changed here is this Ledung's; the config's are where they start."
          : 'Tabs show at the top of the page when the config lists more than one computer. The name is also the remote frame\'s label.'}
      </p>
      {computers.map((c) => <ComputerRow key={c.id} computer={c} run={run} />)}
    </section>
  );
}

function ComputerRow({ computer: c, run }: { computer: ComputerInfo; run: Run }) {
  const typing = usePlainTyping();
  const [name, setName] = useState(c.name);
  useEffect(() => setName(c.name), [c.name]);
  const edited = c.name !== c.config.name || c.colour !== c.config.colour;
  const changed = name.trim() !== c.name;
  const save = () => run(() => api.editComputer(c.id, { name: name.trim() || null }));
  const label = c.here ? `${c.name} (this computer)` : c.name;
  return (
    <div className="computer-row" role="group" aria-label={`Computer ${label}`}>
      <div className="computer-name">
        <input type="text" {...typing} value={name} maxLength={COMPUTER_NAME_MAX} aria-label={`Name of ${label}`}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && changed) void save(); }} />
        {changed && <button className="small primary" onClick={() => void save()}>Save</button>}
        {c.here && <span className="muted">This computer</span>}
        {edited && !changed && (
          <button className="small" title={`Back to ${c.config.name} in ${NAME_COLOURS[c.config.colour].label.toLowerCase()}, as the config has it`}
            onClick={() => void run(() => api.editComputer(c.id, { name: null, colour: null }))}>Use the config's</button>
        )}
      </div>
      <div className="swatches">
        {COMPUTER_COLOURS.map((k) => (
          <button key={k} type="button" className={`swatch${c.colour === k ? ' on' : ''}`} aria-pressed={c.colour === k} title={NAME_COLOURS[k].label}
            aria-label={`${label}: ${NAME_COLOURS[k].label}`} onClick={() => void run(() => api.editComputer(c.id, { colour: k }))}>
            <Named colour={k}>●</Named>
          </button>
        ))}
      </div>
    </div>
  );
}
