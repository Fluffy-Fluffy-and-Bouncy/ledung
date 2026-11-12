// The first-run picker for how questions at a workflow step are written (#293; Martin 2026-11-12, Ledung question #881:
// mockup A, the dialog, "feature-flag it"): two sample question pages side by side, one made-up step written both
// ways, a Use button under each and Skip. Behind testFeatures "step-questions-picker"; Settings opens it again.
import { inFrame } from '../computerFrame.ts';
import { LABEL, SHORT, asksPicker } from '../stepQuestions.ts';
import { useStepQuestions } from '../useStepQuestions.ts';

type Run = (action: () => Promise<unknown>) => Promise<void>;

/** A sample's header, as a question page's: the tier and project on the border, who asked, the run line. */
function Head({ title, asker }: { title: string; asker: string }) {
  return (
    <div className="qhead name-tinted">
      <span className="border-label">Blocks a finished PR - reports-app</span>
      <div className="meta"><strong>Question #57</strong><span className="muted">· {asker} · asked 14:32</span></div>
      <h3>{title}</h3>
      <div className="muted run-line">Workflow: run-4 "Add CSV export to the reports page" · Merge? · your answer moves the run</div>
      <div className="refs"><span className="chip">#42</span></div>
    </div>
  );
}

function Opt({ n, letter, label, detail, cost, pickedBy }: { n: number; letter?: string; label: string; detail?: string; cost?: string; pickedBy?: string }) {
  return (
    <div className="opt">
      <span className="k">{n}</span>
      <span className="lab">{letter && <span className="letter">{letter}</span>}{label}</span>
      {detail && <span className="det">{detail}</span>}
      {cost && <span className="cost muted"><b>Cost</b> · {cost}</span>}
      {pickedBy && <span className="picked-by"><b>Picked by</b> {pickedBy}</span>}
    </div>
  );
}

const other = (n: number) => <Opt n={n} label="Other answer" detail="Say it in your own words." />;

/** Ledung's card for the made-up step, in the words Ledung writes one (#291): the run, where each answer goes, the hand-on. */
function CardSample() {
  return (
    <>
      <Head title="Merge?: Add CSV export to the reports page" asker="Ledung" />
      <section className="block"><h4>The issue</h4><div className="issue">
        <p>Add CSV export to the reports page (#42) is at "Merge?" in the flow "Build and review". Your answer moves it: "Merge" → Ship; "Changes needed" → Fix round.</p>
        <p>"Code review" handed on:</p>
        <p>Approved, no findings. PR #57, 4 files. Tests 214/214.</p>
      </div></section>
      <section className="block"><h4>Options</h4><div className="opts">
        <Opt n={1} label="Merge" />
        <Opt n={2} label="Changes needed" />
        {other(3)}
      </div></section>
    </>
  );
}

/** The manager's write-up for the same step: backstory, evidence, options with cost, opinions. */
function WriteUpSample() {
  return (
    <>
      <Head title="Merge the CSV export for the reports page (PR #57)?" asker="Manager: reports-app" />
      <section className="block"><h4>The issue</h4><div className="issue">
        <p><b>Backstory.</b> The reports page could only be printed. The sales team asked on 3 Nov for a download to open the figures in a spreadsheet; you put it in Ready the same day ("CSV is enough, no Excel").</p>
        <p><b>What was done.</b> An <i>Export CSV</i> button on every report; the file has the columns and filters on screen. Nothing else on the page changed.</p>
      </div></section>
      <section className="block"><div className="ev"><b>Evidence</b>
        <p>Tests 214/214 pass. A 5,000-row report downloads in 0.4 s and opens cleanly in a spreadsheet, accents and all. Code review and test review both approved, no findings.</p>
      </div></section>
      <section className="block"><h4>Options</h4><div className="legend"><span>Green border: the manager's pick</span></div><div className="opts">
        <Opt n={1} letter="a" label="Merge now" detail="It ships with the next release." cost="none; the run goes on to Ship." pickedBy="Manager, Code reviewer" />
        <Opt n={2} letter="b" label="Changes needed: add a date range first" detail="Exports only the dates you choose." cost="about 30 min session time and another review." />
        {other(3)}
      </div></section>
      <section className="block"><h4>Opinions</h4><div className="recs">
        <div><div className="rec-label muted">Manager (asker)</div><div className="rec"><div className="pick">a · Merge now</div><div>Does what was asked; a date range was not part of it and can be its own card.</div></div></div>
        <div><div className="rec-label muted">Code reviewer</div><div className="rec"><div className="pick">a · Merge now</div><div>No findings.</div></div></div>
      </div></section>
    </>
  );
}

/**
 * Over the page on a first run (no choice saved, not skipped) on this computer's own page, or when Settings opens it.
 * Use … saves the choice into Settings → Questions at a workflow step; Skip keeps Ledung's card. Either way it is not
 * asked again.
 */
export function StepQuestionsPicker({ run }: { run: Run }) {
  const { view, shown, choose, skip, show } = useStepQuestions();
  const first = asksPicker(view, inFrame());
  if (!view?.picker || !(first || shown)) return null;
  return (
    <div className="passkey-backdrop picker-backdrop">
      <div className="passkey-dialog picker-dialog" role="dialog" aria-modal="true" aria-labelledby="picker-title">
        <h3 id="picker-title">How should questions at a workflow step reach you?</h3>
        <p className="muted">When a workflow run reaches a step where you decide, such as a merge or a sign-off, it asks you a question. The same made-up step, written both ways:</p>
        <div className="picker-pair">
          {(['card', 'write-up'] as const).map((c) => (
            <div key={c} className="picker-side">
              <span className="picker-tag">{c === 'card' ? 'Sample 1 · the default' : 'Sample 2'}</span>
              <b>{LABEL[c]}</b>
              <span className="muted">{SHORT[c]}</span>
              <div className="picker-frame" inert aria-hidden="true"><div className="desk-body picker-sample">{c === 'card' ? <CardSample /> : <WriteUpSample />}</div></div>
              <div>
                <button className={view.choice === c && !first ? 'small' : 'primary'} onClick={() => void run(() => choose(c))}>
                  {c === 'card' ? "Use Ledung's card" : "Use the manager's write-up"}
                </button>
                {!first && view.choice === c && <span className="muted"> · in use now</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="passkey-actions picker-foot">
          <span className="muted">You can change it any time in Settings → Sessions → Questions at a workflow step.</span>
          {first
            ? <button onClick={() => void run(skip)}>Skip: keep Ledung's card</button>
            : <button onClick={() => show(false)}>Close</button>}
        </div>
      </div>
    </div>
  );
}
