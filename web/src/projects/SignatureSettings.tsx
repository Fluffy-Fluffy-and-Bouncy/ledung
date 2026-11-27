// A project's Signature group (issue #513, docs/steps/project-signature.md): a text per place, Ledung's default or
// Edited with Restore default, a small Off that empties every box, a preview, and the Outbox's own recording switch.
import { useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import {
  LEDUNG_DEFAULT_SIGNATURE, PLACE_LABELS, SIGNATURE_MAX, SIGNATURE_PLACES, emptyTexts, fillSignature, sameTexts, unknownFillIn, type SignaturePlace,
} from '../../../src/shared/signature.ts';
import { usePlainTyping } from '../usePlainTyping.ts';
import type { Settings } from './projectSettings.ts';

/** What each place's text replaces or where it goes, under its name. */
const PLACE_NOTES: Partial<Record<SignaturePlace, string>> = {
  pr: "Replaces Claude Code's line",
  commit: "Replaces Claude Code's trailer",
  trackers: 'Linear, Jira and the like',
};

/** The sample the preview fills in, so a run's fill-ins show. */
const SAMPLE_RUN = { run: 'run-42', workflow: 'Development', model: 'Claude Opus 5.5' };

/**
 * A box as tall as its text, wrapped lines included, so a long line isn't cut off on a phone (review of #518, finding 1).
 * Set from scrollHeight on each change and on resize rather than CSS field-sizing, which iPhone Safari may lack.
 */
function GrowingBox(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const typing = usePlainTyping();
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const fit = () => {
      box.style.height = 'auto';
      const border = box.offsetHeight - box.clientHeight;
      box.style.height = `${box.scrollHeight + border}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [props.value]);
  return <textarea ref={ref} rows={1} {...typing} {...props} />;
}

export function SignatureSettings({ value, onChange, userName, project }: { value: Settings; onChange: (s: Settings) => void; userName: string; project: string }) {
  const [confirming, setConfirming] = useState(false);
  const off = value.signatureOff;
  const edited = !off && !sameTexts(value.signature, LEDUNG_DEFAULT_SIGNATURE);
  const setText = (place: SignaturePlace, text: string) => onChange({ ...value, signature: { ...value.signature, [place]: text } });
  // Off erases the texts (Simon, 2026-11-27: "erases the text in the box"); on again fills in Ledung's default (choice 6a).
  const switchTo = (on: boolean) => {
    setConfirming(false);
    onChange({ ...value, signatureOff: !on, signature: on ? { ...LEDUNG_DEFAULT_SIGNATURE } : emptyTexts() });
  };
  const values = { user: userName, project, ...SAMPLE_RUN };
  const pr = fillSignature(value.signature.pr, values);
  const commit = fillSignature(value.signature.commit, values);
  return (
    <div className="signature">
      <p className="muted">A line added to what its sessions post in your name, so readers can see it came through Ledung.</p>
      <div className="signature-top">
        {!off && <span className="pill grey signature-state">{edited ? 'Edited' : "Ledung's default"}</span>}
        {edited && (confirming
          ? <span className="restart-confirm">Replace your texts with Ledung's default? <button type="button" className="small primary" onClick={() => { setConfirming(false); onChange({ ...value, signature: { ...LEDUNG_DEFAULT_SIGNATURE } }); }}>Restore default</button> <button type="button" className="small" onClick={() => setConfirming(false)}>Cancel</button></span>
          : <button type="button" className="link" onClick={() => setConfirming(true)}>Restore default</button>)}
        <label className="toggle signature-switch" title={off ? "Turning it on fills in Ledung's default" : 'Turning it off clears your texts'}>
          <input type="checkbox" checked={!off} onChange={(e) => switchTo(e.target.checked)} />
          {' '}<span>{off ? 'Off' : 'On'}</span>
        </label>
      </div>
      <p className="muted small-note">
        {off
          ? "Off: no signature anywhere, Claude Code's lines included. Turning it on fills in Ledung's default."
          : 'Change any text and it becomes Edited, with Restore default beside it. An empty text adds nothing there. Turning it off clears your texts.'}
      </p>
      {SIGNATURE_PLACES.map((place) => {
        const id = `signature-${place}`;
        const unknown = unknownFillIn(value.signature[place]);
        return (
          <div key={place} className={`signature-place${off ? ' off' : ''}`}>
            <label htmlFor={id}><span className="field-name">{PLACE_LABELS[place]}</span>{PLACE_NOTES[place] && <span className="muted"> {PLACE_NOTES[place]}</span>}</label>
            <div>
              <GrowingBox id={id} className="mono" maxLength={SIGNATURE_MAX}
                value={value.signature[place]} disabled={off} placeholder={off ? '' : 'Empty: nothing added'}
                onChange={(e) => setText(place, e.target.value)} />
              {unknown && <span className="error small-note">{unknown} is not a fill-in.</span>}
            </div>
          </div>
        );
      })}
      <p className="muted small-note">
        Fill-ins: <code>{'{user}'}</code> <code>{'{project}'}</code> <code>{'{run}'}</code> <code>{'{workflow}'}</code> <code>{'{model}'}</code>. A line whose fill-ins are empty (outside a run, {'{run}'} and {'{workflow}'}) is left out.
        <br />If a repo or your employer asks for AI involvement to be stated, keep a line that says so.
        <br />Issues, comments and other trackers get their texts in a later update; PR descriptions and commits get theirs now.
      </p>
      {!off && (
        <>
          <h4>Preview, in {SAMPLE_RUN.run}</h4>
          <div className="signature-preview mono">
            <span className="muted">PR description:</span>{'\n'}…the description{pr ? `\n\n${pr}` : ''}{'\n'}
            <span className="muted">Commit:</span>{'\n'}…the message{commit ? `\n\n${commit}` : ''}
          </div>
        </>
      )}
      <h4>Outbox</h4>
      <label className="toggle">
        <input type="checkbox" checked={value.recordPosts} onChange={(e) => onChange({ ...value, recordPosts: e.target.checked })} />
        {' '}<span><span className="field-name">Record outside posts</span> <span className="muted">(separate from the signature: posts are recorded even when the signature is off. Kept 30 days, on this computer; recording starts with the Outbox update)</span></span>
      </label>
    </div>
  );
}
