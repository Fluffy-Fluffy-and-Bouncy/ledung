// "142k of 1000k": a session's context as the prompt line says it (issue #18) and Usage → Sessions shows it
// (issue #405), from one place so the two never read differently.

/** Tokens in thousands, with the window when it is known. */
export function contextSize(tokens: number, window: number | null | undefined): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  return `${k(tokens)}${window ? ` of ${k(window)}` : ''}`;
}
