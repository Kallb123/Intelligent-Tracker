/** A half-open range `[start, end)` of the input text. */
export interface Span {
  start: number;
  end: number;
}

/**
 * `text` with the spans replaced by spaces. Every stage works on the same text with what earlier
 * stages understood blanked out, so offsets stay valid against the original and a later stage
 * cannot read the same words twice.
 */
export function blank(text: string, spans: readonly Span[]): string {
  let result = text;
  for (const { start, end } of spans) {
    result = result.slice(0, start) + ' '.repeat(end - start) + result.slice(end);
  }
  return result;
}

const LEADING_JUNK = /^(?:[,;:\-–—]|\b(?:and|then)\b)\s*/i;
const TRAILING_JUNK =
  /\s*(?:[,;:.\-–—]|\b(?:on|by|at|from|until|till|before|for|due|in|and|then)\b)$/i;

/**
 * Turns the text left after every stage into the title: whitespace tidied and, when something
 * was understood and removed, the connectors it leaves dangling at the edges ("renews ,",
 * "due on") dropped. Words inside the title are never touched.
 */
export function cleanTitle(remaining: string, removedSomething: boolean): string {
  let title = remaining
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;:])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .trim();
  if (!removedSomething) return title;
  for (;;) {
    const next = title.replace(LEADING_JUNK, '').replace(TRAILING_JUNK, '').trim();
    if (next === title) return title;
    title = next;
  }
}
