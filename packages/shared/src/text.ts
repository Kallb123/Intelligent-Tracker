/**
 * `text` cut to at most `max` UTF-16 code units (the unit zod's `max` and Postgres counts), backing
 * off by one when the cut would fall between the halves of a surrogate pair, so an emoji is kept
 * whole or dropped whole and no lone surrogate is left (Postgres `jsonb` rejects one).
 */
export function sliceWhole(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return text.slice(0, Math.max(end, 0));
}
