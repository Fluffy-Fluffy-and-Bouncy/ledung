// One byte range of a file from a request's Range header (RFC 9110 §14), for the page's video player (issue #520): a
// <video> asks for "bytes=0-" first and then from wherever the person seeks, and Safari asks for "bytes=0-1" to see
// that ranges work at all.

/** The bytes to send, both ends included. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * What to answer `header` with for a file of `size` bytes: a range (206), `'whole'` (200, the whole file) or
 * `'unsatisfiable'` (416). A header that isn't one plain byte range is ignored, as RFC 9110 allows, so the whole file
 * goes: several ranges at once would need a multipart answer, and no player asks for one.
 */
export function byteRange(header: string | undefined, size: number): ByteRange | 'whole' | 'unsatisfiable' {
  if (header === undefined) return 'whole';
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'whole';
  if (m[1] === '') {
    // "bytes=-N": the last N bytes.
    const last = Number(m[2]);
    if (!Number.isSafeInteger(last)) return 'whole';
    if (last === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? Infinity : Number(m[2]);
  if (!Number.isSafeInteger(start) || (end !== Infinity && !Number.isSafeInteger(end)) || end < start) return 'whole';
  if (start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}
