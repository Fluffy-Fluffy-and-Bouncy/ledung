// Syntax colour for code in the Files pane (issue #225, Martin's screenshot verdicts on question #346: "I think all
// code should be color coded"). highlight.js with a fixed set of common languages, bundled with the page and loaded
// only when the pane first needs it (highlightCore.ts). The language comes from the file's extension; anything
// unknown, and anything past the size cap, stays plain text. highlight.js only wraps text in <span class="hljs-…">
// and escapes the rest, so its output can be put in the page as HTML.
import type { DiffFile, DiffLine } from '../../src/shared/files-pane.ts';

/** Past these a file or a diff is shown plain: colouring a huge file would hold the page up. */
export const HIGHLIGHT_MAX_BYTES = 256 * 1024;
export const HIGHLIGHT_MAX_LINES = 8000;

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  py: 'python',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  cs: 'csharp',
  css: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', csproj: 'xml',
  yml: 'yaml', yaml: 'yaml',
  md: 'markdown', markdown: 'markdown',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  ini: 'ini', toml: 'ini', cfg: 'ini',
  diff: 'diff', patch: 'diff',
};
const BY_NAME: Record<string, string> = { dockerfile: 'dockerfile', '.gitignore': 'bash' };

/** The highlight.js language for a file, from its name; null: shown as plain text. */
export function languageOf(path: string): string | null {
  const name = path.split('/').pop()!.toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name]!;
  const dot = name.lastIndexOf('.');
  return dot === -1 ? null : BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

/** Whether `text` is small enough to colour. */
export const withinCap = (text: string, lines = text.split('\n').length) => text.length <= HIGHLIGHT_MAX_BYTES && lines <= HIGHLIGHT_MAX_LINES;

/**
 * highlight.js's HTML for a whole text, as one HTML string per line: a span open at a line break (a comment or a
 * string across lines) is closed at the end of that line and opened again on the next, so every line stands alone.
 */
export function splitHighlighted(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  for (const part of html.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (!part) continue;
    if (part === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else if (part.startsWith('<span')) {
      open.push(part);
      line += part;
    } else if (part === '</span>') {
      open.pop();
      line += part;
    } else line += part;
  }
  lines.push(line + '</span>'.repeat(open.length));
  return lines;
}

/**
 * A diff's lines coloured, keyed by line: each hunk's new side (unchanged and added lines) and old side (unchanged
 * and deleted) are coloured as runs, so a comment or string spanning lines keeps its colour; null: shown plain.
 */
export function colourDiff(file: DiffFile, hl: Highlighter | null): Map<DiffLine, string> | null {
  const language = languageOf(file.path);
  if (!hl || !language) return null;
  const all = file.hunks.flatMap((h) => h.lines);
  if (!withinCap(all.map((l) => l.text).join('\n'), all.length)) return null;
  const out = new Map<DiffLine, string>();
  for (const h of file.hunks) {
    for (const side of [h.lines.filter((l) => l.kind !== 'del'), h.lines.filter((l) => l.kind === 'del')]) {
      if (!side.length) continue;
      const html = hl(side.map((l) => l.text).join('\n'), language);
      side.forEach((l, i) => out.set(l, html[i] ?? ''));
    }
  }
  return out;
}

/** Colours `text` as `language`, one HTML string per line. */
export type Highlighter = (text: string, language: string) => string[];

let loading: Promise<Highlighter> | null = null;

/** highlight.js with its languages, loaded once, the first time code is shown. */
export function loadHighlighter(): Promise<Highlighter> {
  loading ??= import('./highlightCore.ts').then((m) => m.highlight);
  return loading;
}
