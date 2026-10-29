// highlight.js's core and the languages the Files pane colours (highlight.ts); a chunk of its own, loaded on first use.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { splitHighlighted } from './highlight.ts';

for (const [name, lang] of Object.entries({ bash, csharp, css, diff, dockerfile, go, ini, java, javascript, json, markdown, powershell, python, rust, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, lang);
}

/** `text` coloured as `language`, one HTML string per line; an unknown language comes back escaped, uncoloured. */
export function highlight(text: string, language: string): string[] {
  if (!hljs.getLanguage(language)) return text.split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  return splitHighlighted(hljs.highlight(text, { language, ignoreIllegals: true }).value);
}
