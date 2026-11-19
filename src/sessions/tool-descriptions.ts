// The descriptions of Ledung's own tools, by tool name, as its tool server last gave them to a session (issue #399):
// a question about a refused call to one of them says what the tool does, not just its name. Kept as the servers are
// built, so it needs no round trip to Claude Code. Other servers' tools are described from the session's own list
// (Session.toolDescription, from Claude Code's MCP status).
const own = new Map<string, string>();

/** Notes the tools Ledung's tool server offers (the session's and the helper's), with their descriptions. */
export function rememberOwnTools(tools: readonly { name: string; description?: string }[]): void {
  for (const t of tools) if (t.description) own.set(t.name, t.description);
}

/** The description of one of Ledung's own tools, by its short name (`release`), or null. */
export function ownToolDescription(name: string): string | null {
  return own.get(name) ?? null;
}
