// Claude's replies as Markdown. Every code block gets a copy button that copies its plain text (want 12).
import { createContext, memo, useContext, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isImagePath, ProjectImage } from './ProjectImage.tsx';
import { useStableCallback } from '../useStableCallback.ts';

/** Copies plain text. Browsers only allow the clipboard API on secure pages, which a page opened from
 *  another computer over plain HTTP is not, so there is a fallback for that case. */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-button"
      onClick={async () => {
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

/** True for links to files in the project: no scheme (http:, mailto:, …), not just a #fragment. */
function isFileLink(href: string): boolean {
  if (href.startsWith('#')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(href) || href.startsWith('file:')) return true; // Windows path or file URL
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
}

/** Resolves a link against the folder of the file it appears in, as a project-relative path. */
function resolveLink(baseDir: string, href: string): string {
  const clean = href.replace(/^file:\/\/\/?/, '');
  if (/^[a-zA-Z]:[\\/]/.test(clean) || clean.startsWith('/')) return clean;
  const parts: string[] = baseDir ? baseDir.split('/') : [];
  for (const part of clean.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/**
 * `onOpenFile`: when given, links to files open in the file viewer instead of navigating away.
 * `baseDir`: the project-relative folder links are relative to (empty for chat messages).
 */
export const Markdown = memo(function Markdown({ text, baseDir = '', onOpenFile, sessionId }: { text: string; baseDir?: string; onOpenFile?: (path: string) => void; sessionId?: string }) {
  // Callers often pass a new closure each render; the links only call it on a click.
  const open = useStableCallback((path: string) => onOpenFile?.(path));
  const where = useMemo(() => ({ baseDir, sessionId, onOpenFile: onOpenFile ? open : undefined }), [baseDir, sessionId, !!onOpenFile, open]);
  return (
    <div className="markdown">
      <Where.Provider value={where}>
        <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      </Where.Provider>
    </div>
  );
});

/** What the links and images in a Markdown text need: where it is, and how to open a file. */
const Where = createContext<{ baseDir: string; sessionId?: string; onOpenFile?: (path: string) => void }>({ baseDir: '' });

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = textOf(children).replace(/\n$/, '');
  return (
    <div className="code-block">
      <CopyButton text={code} />
      <pre>{children}</pre>
    </div>
  );
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const { baseDir, onOpenFile } = useContext(Where);
  return onOpenFile && href && isFileLink(href) ? (
    <a
      href={href}
      className="file-link"
      onClick={(e) => {
        e.preventDefault();
        onOpenFile(resolveLink(baseDir, href));
      }}
    >
      {children}
    </a>
  ) : (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

// In the file viewer, only project images are shown; remote ones are never fetched.
function Image({ src, alt }: { src?: unknown; alt?: string }) {
  const { baseDir, sessionId, onOpenFile } = useContext(Where);
  const href = typeof src === 'string' ? src : '';
  if (!sessionId || !href || !isFileLink(href) || href.startsWith('file:')) {
    return <span className="image-note">[image not shown{alt ? `: ${alt}` : ''}]</span>;
  }
  const path = resolveLink(baseDir, href.replace(/[?#].*$/, ''));
  if (!isImagePath(path) || path.startsWith('..')) {
    return <span className="image-note">[image not shown{alt ? `: ${alt}` : ''}: only PNG and JPEG images inside the project]</span>;
  }
  return <ProjectImage sessionId={sessionId} path={path} alt={alt} onClick={() => onOpenFile?.(path)} />;
}

function Table({ children }: { children?: ReactNode }) {
  return (
    <div className="table-scroll">
      <table>{children}</table>
    </div>
  );
}

// Made once, not in the render: React takes a component made anew as a new kind of element, and throws the old one
// away for a new one on every redraw. Every live update then drew each code block and table anew, back at the left
// of their sideways scroll, and loaded each image again (issue #200).
const COMPONENTS: Components = { pre: CodeBlock, a: Link, img: Image, table: Table };
const PLUGINS = [remarkGfm];
