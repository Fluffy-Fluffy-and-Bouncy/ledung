// A tool call in plain words (issue #399, Simon 2026-11-19: a refused-call question "only said that it blocked the
// following command: {}", for Ledung's own `release`, which takes no input). Every place that shows the person a call
// to judge names the tool: a shell command as it is, an MCP tool as its server and tool ("Ledung · release"), any
// other tool by its name and the input that says what it touches (a file, a URL). The rest of the input is shown as
// `key: value` lines, never as bare JSON, and not at all when there is none. Shared: the page uses it too.

/** The server and tool of an MCP tool's full name (`mcp__<server>__<tool>`), else null. */
export function mcpParts(toolName: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

/** Ledung's own tool server goes by its name; any other by the name it was configured under. */
function serverLabel(server: string): string {
  return server === 'ledung' ? 'Ledung' : server;
}

/** The tool by name: "Ledung · release" for an MCP tool, the tool's own name otherwise ("Bash", "Edit"). */
export function toolLabel(toolName: string): string {
  const mcp = mcpParts(toolName);
  return mcp ? `${serverLabel(mcp.server)} · ${mcp.tool}` : toolName;
}

/** Whether the call is a shell command, shown as the command itself. */
export function isShell(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'PowerShell';
}

// The input that says what a built-in tool touches, in the order looked for, with how the person reads it.
const KEY_INPUTS: [key: string, label: string][] = [
  ['file_path', 'File'], ['notebook_path', 'Notebook'], ['url', 'URL'], ['path', 'Path'], ['pattern', 'Pattern'], ['query', 'Query'],
];

/** The input that says what a built-in tool touches (a file, a URL), when it has one; never for an MCP tool or a shell. */
export function keyInput(toolName: string, input: Record<string, unknown>): { key: string; label: string; value: string } | null {
  if (isShell(toolName) || mcpParts(toolName)) return null;
  for (const [key, label] of KEY_INPUTS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return { key, label, value: v.trim() };
  }
  return null;
}

/** Whether the call has any input to show. */
export function hasInput(input: Record<string, unknown> | null | undefined): boolean {
  return !!input && Object.keys(input).length > 0;
}

/**
 * The input as `key: value` lines, readable without knowing JSON: a text as it is (its further lines indented), a
 * number or yes/no as such, a list or object as compact JSON, or indented JSON when long. `omit`: keys already shown.
 * Empty when there is nothing (left).
 */
export function inputLines(input: Record<string, unknown> | null | undefined, omit: readonly string[] = []): string {
  if (!input) return '';
  const lines: string[] = [];
  for (const [key, v] of Object.entries(input)) {
    if (omit.includes(key)) continue;
    let text: string;
    if (typeof v === 'string') text = v;
    else if (v === null || typeof v !== 'object') text = String(v);
    else {
      const flat = JSON.stringify(v);
      text = flat.length <= 100 ? flat : JSON.stringify(v, null, 2);
    }
    lines.push(`${key}: ${text.replace(/\r?\n/g, '\n  ')}`);
  }
  return lines.join('\n');
}

const cut = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The call in one plain line, for a title or a list: "Bash: git push", "Ledung · release", "Edit: C:\x\a.ts". `max`
 * cuts what follows the tool's name.
 */
export function callLine(toolName: string, input: Record<string, unknown>, max = 100): string {
  const label = toolLabel(toolName);
  if (isShell(toolName) && typeof input.command === 'string') return `${label}: ${cut(input.command, max)}`;
  const key = keyInput(toolName, input);
  return key ? `${label}: ${cut(key.value, max)}` : label;
}

/**
 * A tool's description cut to its first sentence, for one line beside its name (a tool's description can run long:
 * Ledung's own tools say when and how to use them). Null when there is none.
 */
export function oneLineDescription(description: string | null | undefined, max = 200): string | null {
  const text = (description ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // A sentence ends where the next one starts with a capital ("e.g. the" goes on).
  const end = /(?<!\be\.g|\bi\.e)[.!?](?=\s+[A-Z]|$)/.exec(text);
  const first = end ? text.slice(0, end.index + 1) : text;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
