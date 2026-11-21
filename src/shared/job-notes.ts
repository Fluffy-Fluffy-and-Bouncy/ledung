// What the person reads about Pause and Stop on a job's card (acceptance test 5 of PR #476): the confirm counts only
// the processes Stop will end, and names the programs Ledung only guessed were the job's (taken by when they started,
// their command not the session's), which are left alone; after the action the page says the same.

/** What Stop or Pause would act on, found just before the person's confirm. */
export interface JobReach {
  /** The processes the action will act on. */
  act: number;
  /** How many processes Ledung only guessed were the job's; left alone. */
  others: number;
  /** Their programs' names, each once. */
  names: string[];
}

/** The result of the person's Pause, Resume or Stop. */
export interface JobActionResult {
  done: number;
  /** The programs left alone, by name. */
  leftAlone: string[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "game.exe", "game.exe and conhost.exe", "a.exe, b.exe and c.exe"; "a program" when no name is known. */
export function namesText(names: string[]): string {
  if (!names.length) return 'a program';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The confirm before Stop. */
export function stopConfirmText(what: string, reach: JobReach): string {
  const head = reach.act
    ? `Stop "${what}"? Its ${plural(reach.act, 'process', 'processes')} will be ended, and the session told.`
    : `Stop "${what}"? None of its own processes are still running; the session will be told.`;
  if (!reach.others) return head;
  const them = reach.others === 1 ? 'it' : 'them';
  return `${head} ${plural(reach.others, 'other', 'others')} Ledung only guessed ${reach.others === 1 ? 'belongs' : 'belong'} to it (${namesText(reach.names)}) ${reach.others === 1 ? 'is' : 'are'} left alone and taken off the job; Stop never ends ${them}.`;
}

/** The note on the page after the person's action; null when there is nothing to say. */
export function jobActionNote(action: 'pause' | 'resume' | 'stop', what: string, result: JobActionResult): string | null {
  const alone = result.leftAlone.length
    ? ` Left alone: ${namesText(result.leftAlone)}. Ledung only guessed ${result.leftAlone.length === 1 ? 'it belongs' : 'they belong'} to the job, from when ${result.leftAlone.length === 1 ? 'it' : 'they'} started, so it doesn't ${action === 'stop' ? 'end' : 'pause'} ${result.leftAlone.length === 1 ? 'it' : 'them'}${action === 'stop' ? '; no longer counted as the job\'s' : ''}.`
    : '';
  if (action === 'stop') return `Stopped "${what}": ${result.done ? `${plural(result.done, 'process', 'processes')} ended` : 'none of its own processes were still running'}.${alone}`;
  if (action === 'pause' && alone) return `Paused "${what}".${alone}`;
  return null;
}
