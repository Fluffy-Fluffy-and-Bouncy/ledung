// A read-only panel showing a file from the session's project folder, opened from a link in the chat.
// Links inside a Markdown file open the linked file in the same panel, with Back.
import { useEffect, useMemo, useState } from 'react';
import { languageOf, withinCap } from '../highlight.ts';
import { useHighlighter } from '../useHighlighter.ts';
import type { ProjectFileView } from '../../../src/shared/protocol.ts';
import { api } from '../api.ts';
import { CopyButton, Markdown } from './Markdown.tsx';
import { isImagePath, ProjectImage } from './ProjectImage.tsx';

/** The folder part of a project-relative path ("docs/steps/a.md" → "docs/steps"). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** A text file's lines, numbered beside it; the numbers are drawn by CSS, so copying takes only the text (issue #225). */
export function NumberedText({ text, path }: { text: string; path: string }) {
  const lines = text.replace(/\n$/, '').split('\n');
  const hl = useHighlighter();
  const language = languageOf(path);
  // Coloured by its extension (Martin on question #346); unknown types and files past the cap stay plain.
  const coloured = useMemo(
    () => (hl && language && withinCap(text, lines.length) ? hl(lines.join('\n'), language) : null),
    [hl, language, text],
  );
  return (
    <pre className="file-text numbered hl" style={{ ['--ln-width' as string]: `${String(lines.length).length + 1}ch` }}>
      <code>{coloured
        ? coloured.map((html, i) => <span className="ln-row" key={i} dangerouslySetInnerHTML={{ __html: `${html}\n` }} />)
        : lines.map((l, i) => <span className="ln-row" key={i}>{l}{'\n'}</span>)}</code>
    </pre>
  );
}

export function FileViewer(props: {
  sessionId: string; stack: string[]; onOpen: (path: string) => void; onBack: () => void; onClose: () => void;
  /** Opened from the Files pane (issue #225): which of the session's folders, and Back returns to the pane. */
  folder?: 'session' | 'project';
  backToPane?: boolean;
}) {
  const link = props.stack[props.stack.length - 1]!;
  const [file, setFile] = useState<ProjectFileView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const image = isImagePath(link);

  useEffect(() => {
    setFull(false);
    if (image) return; // An image is loaded by the <img> itself.
    let current = true;
    setFile(null);
    setError(null);
    api.file(props.sessionId, link, props.folder).then(
      (f) => current && setFile(f),
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [props.sessionId, link, image, props.folder]);

  return (
    <aside className="file-panel" aria-label="File">
      <header className="file-head">
        {(props.stack.length > 1 || props.backToPane) && <button className="small" onClick={props.onBack}>{props.backToPane && props.stack.length === 1 ? '‹ Files' : 'Back'}</button>}
        <span className="file-path" title={(!image && file?.path) || link}>{(!image && file?.path) || link}</span>
        {image && <button className="small" onClick={() => setFull(!full)}>{full ? 'Fit to panel' : 'Full size'}</button>}
        {!image && file && <CopyButton text={file.content} label="Copy all" />}
        <button className="small" onClick={props.onClose} aria-label="Close">Close</button>
      </header>
      <div className="file-body">
        {!image && error && <p className="error">{error}</p>}
        {image && <ProjectImage key={link} sessionId={props.sessionId} path={link} folder={props.folder} full={full} onClick={() => setFull(!full)} />}
        {!image && !file && !error && <p className="muted">Loading…</p>}
        {!image && file?.kind === 'markdown' && <Markdown text={file.content} baseDir={dirOf(file.path)} onOpenFile={props.onOpen} sessionId={props.sessionId} />}
        {!image && file?.kind === 'text' && <NumberedText text={file.content} path={file.path} />}
      </div>
    </aside>
  );
}
