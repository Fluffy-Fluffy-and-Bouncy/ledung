// Calls the auto mode classifier refused (issue #104): Ledung sees the refusal in the session's stream and asks the
// person at once, at the top of Waiting for you and with a push, "Allow once" or "Deny". Allow once is a one-shot
// grant for that exact call in that session, honoured by Ledung's PreToolUse hook (an `allow` there gets past the
// classifier, as the merge on an answer showed). Nothing here grants anything without the person's own answer.
//
// Allow always (issue #225) is the third answer for a shell command: a rule of the project for that exact command,
// kept in the database (allowed_calls), listed and removable in the project's settings, and honoured by the same hook.
//
// The grant is kept as the answered question itself, and used up through the store's words_used (atomic), so a
// restart neither loses nor repeats it. Kept apart from the session so the order record (#105) can grant a call the
// same way: `sameCall` and `onceGrant` know nothing about where the grant came from but the question.
import type { QuestionInfo } from '../shared/protocol.ts';
import type { QuestionDetails, RefusalDetails } from '../shared/questions.ts';
import type { Store } from '../store/store.ts';

/** What Claude Code puts in the tool result when the classifier refuses a call (its own text, Claude Code 2.1.x). */
export const CLASSIFIER_REFUSAL = 'Permission for this action was denied by the Claude Code auto mode classifier.';

/** The answers the person can give; the question offers them as its buttons. */
export const ALLOW_ONCE = 'Allow once';
export const DENY = 'Deny';
/**
 * Allow always (issue #225; Martin 2026-11-11 21:24: "if I approve of something then that approval has to stay"):
 * exactly this command, in every session of the project, from now on, until removed in the project's settings.
 */
export const ALLOW_ALWAYS = 'Allow always';
/** Allow always for a command on the project's sensitive list: its own button, so it is never given by mistake. */
export const ALLOW_ALWAYS_SENSITIVE = 'Allow always, though sensitive';
/** The answer to a refusal only the person can make (Project-Ledung#470): they made the change themself. */
export const DONE_BY_HAND = 'Done by hand';

/** How long an Allow once waits for the retry: a day, then the session must be refused and asked again. */
export const ONCE_GRANT_MS = 24 * 3600 * 1000;

/** The words_used action a used grant is recorded under (with the question's key `q<id>`). */
export const ONCE_ACTION = 'once-grant';

/**
 * The classifier's reason when a tool result is its refusal, else null. `content` is the tool result's content as
 * Claude Code sends it: a string, or text blocks.
 */
export function classifierReason(content: unknown): string | null {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n') : '';
  // Claude Code's refusal starts the result: a failing command whose output merely contains the sentence is no refusal
  // (review of PR #106, finding 3).
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(CLASSIFIER_REFUSAL)) return null;
  const rest = trimmed.slice(CLASSIFIER_REFUSAL.length);
  // One line (agent SDK 0.3.295): "Reason: <why>. If you have other tasks …" then its advice to the model, which the
  // person needs no copy of. Cut where Claude Code's own screen cuts, else at the line's end.
  const m = /^\s*Reason:\s*([^\n]*)/.exec(rest);
  const line = m?.[1] ?? '';
  const advice = line.indexOf(MODEL_ADVICE);
  return (advice >= 0 ? line.slice(0, advice) : line).trim() || 'none given';
}

/** Where Claude Code's advice to the model starts, right after the reason (its own screen cuts the reason here). */
const MODEL_ADVICE = ". If you have other tasks that don't depend on this action";

/** The tools whose top-level `description` is only the model's label for the call, never part of what it does. */
const LABELLED_TOOLS = ['Bash', 'PowerShell'];

/**
 * The part of a call that makes it the same call: all of its input, except a shell command's top-level description.
 * Any other tool's description can be its payload (an issue's text, say), so it counts (review of PR #106, finding 2).
 */
function callKey(toolName: string, input: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
    return typeof v === 'string' ? v.trim() : v;
  };
  const { description: _label, ...rest } = input;
  return JSON.stringify(canonical(LABELLED_TOOLS.includes(toolName) ? rest : input));
}

/**
 * Whether a call is exactly the one granted: the same tool and the same input, a shell command's description aside. No
 * prefix, no wildcard: a command with anything chained onto it (`;`, `&&`, a pipe) is another command.
 */
export function sameCall(granted: { toolName: string; input: Record<string, unknown> }, toolName: string, input: Record<string, unknown>): boolean {
  return granted.toolName === toolName && callKey(granted.toolName, granted.input) === callKey(toolName, input);
}

/** The tools that write a file named in their input; Claude Code checks that path before any hook's allow counts. */
const FILE_WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

// The paths Claude Code guards itself, read from its program (2.1.316). Writing to one is a safety check that a
// PreToolUse hook's allow doesn't lift ("Hook returned 'allow' …, but an ask rule, a safety check … requires the full
// permission pipeline"). So in auto mode the call goes to the classifier whatever the person answered to Ledung's
// Allow once (Project-Ledung#470, reproduced with a hook that allows everything). The list has folders anywhere in
// the path and file names. Claude Code lets through some folders under .claude: a worktree, skills, agents, commands.
const GUARDED_FOLDERS = ['.git', '.vscode', '.idea', '.claude', '.husky', '.cargo', '.devcontainer', '.yarn', '.mvn'];
const CLAUDE_OPEN_FOLDERS = ['worktrees', 'skills', 'agents', 'commands'];
const GUARDED_FILES = [
  '.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.zshenv', '.zlogin',
  '.zlogout', '.bash_login', '.bash_aliases', '.bash_logout', '.envrc', '.ripgreprc', '.mcp.json', '.claude.json',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnp.cjs', '.pnp.loader.mjs', '.pnpmfile.cjs', 'bunfig.toml', '.bunfig.toml',
  '.bazelrc', '.bazelversion', '.bazeliskrc', '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml',
  'lefthook.yaml', '.lefthook.yaml', 'gradle-wrapper.properties', 'maven-wrapper.properties', '.devcontainer.json',
  'pyrightconfig.json', 'managed-settings.json',
];

/** The file a call writes, when it is a file tool's. */
function writtenFile(toolName: string, input: Record<string, unknown>): string | null {
  if (!FILE_WRITE_TOOLS.includes(toolName)) return null;
  const file = input.file_path ?? input.notebook_path;
  return typeof file === 'string' && file.trim() ? file.trim() : null;
}

/**
 * The guarded file a call writes, when Ledung's Allow once can't get it past Claude Code (Project-Ledung#470), else
 * null. Only file tools count here: what a shell command writes can't be read off the command. When Allow once can't
 * lift a shell call, the person hears it after the retry is refused again.
 */
export function guardedWrite(toolName: string, input: Record<string, unknown>): string | null {
  const file = writtenFile(toolName, input);
  if (!file) return null;
  const parts = file.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());
  let opened = false;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (part === '.config' && parts[i + 1] === 'git') return file;
    if (!GUARDED_FOLDERS.includes(part)) continue;
    // Claude Code lets one .claude/worktrees (or skills, agents, commands) through; a .claude below it is guarded again.
    if (part === '.claude' && !opened && CLAUDE_OPEN_FOLDERS.includes(parts[i + 1]!)) {
      opened = true;
      continue;
    }
    return file;
  }
  return GUARDED_FILES.includes(parts.at(-1) ?? '') ? file : null;
}

/** How the person makes the call themself: the exact edit, the file's whole content, or the command to run. */
export function byHandText(r: Pick<RefusalDetails, 'toolName' | 'input'>): string {
  const { toolName, input } = r;
  const file = writtenFile(toolName, input);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const replace = (e: Record<string, unknown>) =>
    `Replace ${e.replace_all === true ? 'every occurrence of this text' : 'this text'}:\n\n${fenced(str(e.old_string))}\n\nwith:\n\n${fenced(str(e.new_string))}`;
  if (file && toolName === 'Edit') return `Open \`${file}\` and make this one edit. ${replace(input)}`;
  if (file && toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    const edits = (input.edits as Record<string, unknown>[]).map((e, i) => `${i + 1}. ${replace(e)}`);
    return `Open \`${file}\` and make these edits, in this order:\n\n${edits.join('\n\n')}`;
  }
  if (file && toolName === 'Write') return `Write \`${file}\` with exactly this content (it replaces what is there):\n\n${fenced(str(input.content))}`;
  if (file && toolName === 'NotebookEdit') {
    return `In the notebook \`${file}\`, ${str(input.edit_mode) || 'replace'} the cell ${str(input.cell_id) || 'the call names'} with:\n\n${fenced(str(input.new_source))}`;
  }
  if ((toolName === 'Bash' || toolName === 'PowerShell') && typeof input.command === 'string') {
    return `Run this yourself, in ${toolName}, in the session's folder:\n\n${fenced(input.command, toolName === 'Bash' ? 'bash' : 'powershell')}`;
  }
  return `Make this ${toolName} call yourself:\n\n${fenced(JSON.stringify(input, null, 2), 'json')}`;
}

/** The refused call a question is about, when Ledung raised it; null for any other question. */
export function refusalOf(q: Pick<QuestionInfo, 'details'>): RefusalDetails | null {
  return q.details?.refusal ?? null;
}

/** Whether an answer is the person's Allow once: the button, or the button with a note under it. */
export function allowsOnce(answer: string | null): boolean {
  if (answer === null) return false;
  const a = answer.trim();
  return a === ALLOW_ONCE || a.startsWith(`${ALLOW_ONCE}\n\nNote: `);
}

/**
 * Which Allow always a call can be offered (issue #225), or null: only a shell command, which a rule can name exactly,
 * and never one Allow once can't lift either (Project-Ledung#470). `sensitiveRule` is the project's sensitive rule the
 * command matches, if any: then the button says so.
 */
export function alwaysOffer(toolName: string, input: Record<string, unknown>, byHand: boolean, sensitiveRule: string | null): 'plain' | 'sensitive' | null {
  if (byHand || !LABELLED_TOOLS.includes(toolName) || typeof input.command !== 'string' || !input.command.trim()) return null;
  return sensitiveRule === null ? 'plain' : 'sensitive';
}

/**
 * Whether an answered refusal question is the person's Allow always, and which: the button the question offered,
 * alone or with a note under it, by the person themself (not passed on by a manager). A typed "Allow always" on a
 * question that offered the sensitive button, or none, allows nothing.
 */
export function allowsAlways(q: Pick<QuestionInfo, 'details' | 'answer' | 'answeredBy' | 'forwardedFrom' | 'status'>): 'plain' | 'sensitive' | null {
  const r = refusalOf(q);
  if (!r?.always || r.byHand || q.status !== 'answered' || q.answeredBy !== 'user' || q.forwardedFrom !== null || q.answer === null) return null;
  const label = r.always === 'sensitive' ? ALLOW_ALWAYS_SENSITIVE : ALLOW_ALWAYS;
  const a = q.answer.trim();
  return a === label || a.startsWith(`${label}\n\nNote: `) ? r.always : null;
}

/**
 * Records the person's Allow always (issue #225), when the answered question is one: the exact command becomes a rule
 * of the session's project, with who allowed it, when and on which question. Called when the person answers, before
 * the answer reaches the session, so the session's retry is let through by the rule. True when a rule was recorded.
 */
export function recordAllowAlways(
  store: Pick<Store, 'getSession' | 'addAllowedCall'>, q: QuestionInfo, userName: string,
): boolean {
  const always = allowsAlways(q);
  const r = refusalOf(q);
  const project = store.getSession(q.sessionId)?.project;
  if (!always || !r || typeof r.input.command !== 'string' || project === undefined) return false;
  store.addAllowedCall({ project, toolName: r.toolName, command: r.input.command, sensitive: always === 'sensitive', allowedBy: userName, questionId: q.id });
  return true;
}

/**
 * The person's Allow once that covers this call, if any: a refusal question of this session, answered Allow once by
 * the person themself (not passed on by a manager, which forward_answer does), within the last day, for exactly this
 * call from the same caller (the session itself, or a subagent of it). Whether it is still unused is the store's to say (words_used), so the caller uses it up atomically.
 */
export function onceGrant(
  questions: readonly QuestionInfo[], sessionId: string, toolName: string, input: Record<string, unknown>, now: number, byAgent = false,
): QuestionInfo | null {
  return questions.find((q) => {
    const r = refusalOf(q);
    return !!r && q.sessionId === sessionId && q.status === 'answered' && q.answeredBy === 'user' && q.forwardedFrom === null
      && allowsOnce(q.answer) && (q.answeredAt ?? 0) > now - ONCE_GRANT_MS && sameCall(r, toolName, input)
      // A question that offered no Allow once grants nothing, whatever words its answer has (Project-Ledung#470).
      && !r.byHand
      // The session's own grant is not a subagent's, nor the other way round (issue #146).
      && (r.byAgent ?? false) === byAgent;
  }) ?? null;
}

/** The call as the person reads it: a shell command as it is, any other tool as its input. */
export function callText(r: Pick<RefusalDetails, 'toolName' | 'input'>): string {
  const command = r.input.command;
  if ((r.toolName === 'Bash' || r.toolName === 'PowerShell') && typeof command === 'string') return command;
  return JSON.stringify(r.input, null, 2);
}

/** A fenced block that the text can't close early. */
function fenced(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((s) => s.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

/**
 * The question Ledung asks the person (issue #104): the session, its project, the exact call and the classifier's
 * reason, with Allow once and Deny. In the project's first tier and ranked first, so it heads Waiting for you. When
 * Allow once can't lift it (Project-Ledung#470), it isn't offered: the question says only the person can do it, and
 * how, with Done by hand and Deny.
 */
export function refusalQuestion(
  r: RefusalDetails, session: { title: string; project: string }, tier: string | undefined,
): { question: string; options: string[]; details: QuestionDetails } {
  const shell = r.toolName === 'Bash' || r.toolName === 'PowerShell';
  const what = shell ? `${r.toolName} command` : `${r.toolName} call`;
  const call = fenced(callText(r), shell ? (r.toolName === 'Bash' ? 'bash' : 'powershell') : 'json');
  const reason = `**The classifier's reason:** ${r.reason}`;
  if (r.byHand) {
    const title = `Only you can make this change for "${session.title}"`;
    const why = r.byHand === 'retried'
      ? `You allowed this ${what} once${r.retryOf !== undefined ? ` (question #${r.retryOf})` : ''}. The session "${session.title}" (project ${session.project}) retried it unchanged, and the auto mode classifier refused it again. **Allow once can't get this call past Claude Code**, so Ledung doesn't offer it again.`
      : `The auto mode classifier refused this ${what} in the session "${session.title}" (project ${session.project}). It writes \`${guardedWrite(r.toolName, r.input)}\`, a file Claude Code guards itself. **Allow once in Ledung can't get it past Claude Code**, so Ledung doesn't offer it.`;
    const issue = [
      why,
      call,
      reason,
      `**Only you can do it.** ${byHandText(r)}`,
      `Then answer **${DONE_BY_HAND}**: the session is told you made the change, and goes on without retrying it. **${DENY}** tells the session you said no.`,
    ].join('\n\n');
    const details: QuestionDetails = { title, issue, ...(tier ? { tier } : {}), rank: 0, refusal: r };
    return { question: `**${title}**\n\n${issue}`, options: [DONE_BY_HAND, DENY], details };
  }
  const title = `Auto mode refused a call in "${session.title}"`;
  const always = r.always === 'sensitive' ? ALLOW_ALWAYS_SENSITIVE : r.always === 'plain' ? ALLOW_ALWAYS : null;
  const issue = [
    `The auto mode classifier refused this ${what} in the session "${session.title}" (project ${session.project}).`,
    call,
    reason,
    `**${ALLOW_ONCE}** lets exactly this call run one time: Ledung tells the session to retry it, and lets the retry through. ` +
      `Any other command, and a second run of this one, is refused or asked as usual.` +
      (always
        ? ` **${always}** lets exactly this command run from now on, in every session of project ${session.project}, without the classifier and without asking you; ` +
          `a changed command (other arguments, a pipe, another command chained on) is asked as before. You can remove it in the project's settings, under What always goes to you.`
        : '') +
      ` **${DENY}** tells the session you said no.`,
    ...(r.always === 'sensitive'
      ? [`**This command is on the project's sensitive list** (${r.sensitiveRule ?? 'a sensitive rule'}). **${ALLOW_ALWAYS_SENSITIVE}** lets it past that list too, so it will no longer come to you.`]
      : []),
  ].join('\n\n');
  const details: QuestionDetails = { title, issue, ...(tier ? { tier } : {}), rank: 0, refusal: r };
  return { question: `**${title}**\n\n${issue}`, options: always ? [ALLOW_ONCE, always, DENY] : [ALLOW_ONCE, DENY], details };
}

/** What the session is told when the person answered (buildDelivery): retry once, stop, or what they said instead. */
export function refusalAnswerText(q: QuestionInfo, userName: string): string {
  const r = refusalOf(q)!;
  const call = fenced(callText(r));
  if (r.byHand && q.answer?.trim() === DONE_BY_HAND) {
    return `${userName} made this change by hand (Ledung's question #${q.id}), because Allow once can't get the call past Claude Code. Don't retry it:\n\n${call}\n\nCheck the result if you need to, and go on.`;
  }
  // A question that offered no Allow once grants none, whatever its words say (Project-Ledung#470).
  if (allowsOnce(q.answer) && !r.byHand) {
    const note = q.answer!.trim().slice(ALLOW_ONCE.length).replace(/^\s*Note:\s*/, '').trim();
    return `${userName} allowed, once, the call the auto mode classifier refused (Ledung's question #${q.id}). Retry exactly this call now, one time, unchanged:\n\n${call}\n\n` +
      'Ledung lets that one retry through; it does not cover any other command, a changed one, or a second run.' +
      (note ? `\n\n${userName}'s note: ${note}` : '');
  }
  const always = allowsAlways(q);
  if (always) {
    const label = always === 'sensitive' ? ALLOW_ALWAYS_SENSITIVE : ALLOW_ALWAYS;
    const note = q.answer!.trim().slice(label.length).replace(/^\s*Note:\s*/, '').trim();
    return `${userName} allowed always the call the auto mode classifier refused (Ledung's question #${q.id}). Retry exactly this call now, unchanged:\n\n${call}\n\n` +
      'Ledung lets exactly this command through from now on, in every session of this project. A changed command (other arguments, a pipe, another command chained on) is not covered and is refused or asked as usual.' +
      (note ? `\n\n${userName}'s note: ${note}` : '');
  }
  if (q.answer?.trim() === DENY) {
    return `${userName} declined the call the auto mode classifier refused (Ledung's question #${q.id}):\n\n${call}\n\nDon't retry it, and don't ask again for it; go on without it, or say what you need instead.`;
  }
  return `${userName} answered Ledung's question #${q.id} about the call the auto mode classifier refused, without allowing it:\n\n${q.answer ?? ''}\n\nNothing was allowed; don't retry the call unless the answer tells you how.`;
}
