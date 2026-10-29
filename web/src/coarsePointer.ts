/**
 * A touch screen as the main pointer (issue #173): keyboard hints mean nothing there and take room. The CSS hides
 * the hints on the page under the same query; this is for text the CSS can't reach, such as a placeholder.
 */
export const COARSE_QUERY = '(pointer: coarse)';

export const coarsePointer = (): boolean => typeof matchMedia === 'function' && matchMedia(COARSE_QUERY).matches;
