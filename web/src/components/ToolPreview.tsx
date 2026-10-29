// Shows what a tool call will do: the command, the diff, or the file it touches.
import { diffLines } from 'diff';
import { CopyButton } from './Markdown.tsx';

type Input = Record<string, any>;

function Diff({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after);
  return (
    <pre className="diff">
      {parts.map((part, i) => {
        const cls = part.added ? 'diff-add' : part.removed ? 'diff-del' : 'diff-same';
        const sign = part.added ? '+' : part.removed ? '-' : ' ';
        const lines = part.value.replace(/\n$/, '').split('\n');
        return (
          <span key={i} className={cls}>
            {lines.map((l) => `${sign} ${l}`).join('\n')}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

function Code({ text }: { text: string }) {
  return (
    <div className="code-block">
      <CopyButton text={text} />
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function filePath(input: Input): string | null {
  return typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
}

export function toolSummary(toolName: string, input: Input): string {
  if (toolName === 'Bash' && typeof input.command === 'string') return input.command.split('\n')[0]!;
  const file = filePath(input);
  if (file) return file;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.description === 'string') return input.description;
  return '';
}

export function ToolPreview({ toolName, input }: { toolName: string; input: Input }) {
  const file = filePath(input);
  switch (toolName) {
    case 'Bash':
      return (
        <>
          {input.description && <p className="muted">{input.description}</p>}
          <Code text={String(input.command ?? '')} />
          {input.run_in_background && <p className="muted">Runs in the background.</p>}
        </>
      );
    case 'Edit':
      return (
        <>
          <p className="path">{file}{input.replace_all ? ' (every occurrence)' : ''}</p>
          <Diff before={String(input.old_string ?? '')} after={String(input.new_string ?? '')} />
        </>
      );
    case 'MultiEdit':
      return (
        <>
          <p className="path">{file}</p>
          {(input.edits ?? []).map((e: Input, i: number) => (
            <Diff key={i} before={String(e.old_string ?? '')} after={String(e.new_string ?? '')} />
          ))}
        </>
      );
    case 'Write':
      return (
        <>
          <p className="path">{file} (whole file)</p>
          <Diff before="" after={String(input.content ?? '')} />
        </>
      );
    case 'NotebookEdit':
      return (
        <>
          <p className="path">{input.notebook_path}</p>
          <Code text={String(input.new_source ?? '')} />
        </>
      );
    default:
      return <Code text={JSON.stringify(input, null, 2)} />;
  }
}
