// The desktop app's windows (#414): File → New Window opens another, so the app keeps a list instead of one window.
// No Electron in it, so the root tests run it (test/desktop.test.ts); main.ts keeps one of these for its windows.

/**
 * The app's open windows, the most recently used last. A window is "used" when it opens or gains focus; the Dock, a
 * second start and a notification's click with no window of its own bring `latest()` forward.
 */
export class WindowList<W> {
  #order: W[] = [];

  /** A window just opened: it is the latest. */
  add(w: W): void {
    this.#used(w);
  }

  /** A window gained focus: it becomes the latest. A window not in the list is ignored (it was closed meanwhile). */
  focused(w: W): void {
    if (this.#order.includes(w)) this.#used(w);
  }

  /** A window was closed for real. */
  remove(w: W): void {
    this.#order = this.#order.filter((x) => x !== w);
  }

  /** The most recently used window, or null when none is open. */
  latest(): W | null {
    return this.#order.at(-1) ?? null;
  }

  has(w: W): boolean {
    return this.#order.includes(w);
  }

  all(): readonly W[] {
    return [...this.#order];
  }

  get size(): number {
    return this.#order.length;
  }

  /**
   * Whether closing `w` hides it instead of closing it: only the last window hides (#359's behaviour, so the app keeps
   * running and its notifications keep coming); any other closes for real, and the rest stay. One not in the list
   * (never added) hides too, so nothing closes by mistake.
   */
  closeHides(w: W): boolean {
    return this.#order.length <= 1 || !this.#order.includes(w);
  }

  #used(w: W): void {
    this.#order = [...this.#order.filter((x) => x !== w), w];
  }
}
