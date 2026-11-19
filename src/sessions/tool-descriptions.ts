// The descriptions of Ledung's own tools, by short tool name (`release`), as a tool server is built (issue #399): a
// question about a refused call to one of them says what the tool does, with no round trip to Claude Code. Some
// descriptions name the session's manager or project (ask_user's "Ask <manager> a question."), so each session keeps
// those of the server it built (review of PR #401), not one list for all of Ledung. Other servers' tools are described
// from the session's own list (Session.mcpDescriptions, from Claude Code's MCP status).

/** Called with the descriptions of a tool server's tools when it is built. */
export type DescribeTools = (descriptions: Map<string, string>) => void;

/** The tools' descriptions by name, those that have one. */
export function toolDescriptions(tools: readonly { name: string; description?: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tools) if (t.description) map.set(t.name, t.description);
  return map;
}
