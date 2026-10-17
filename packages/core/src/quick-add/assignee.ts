import type { QuickAddMember } from './types.js';
import type { Span } from './spans.js';

// "@Sam" or "for Sam", then up to two more words so a full name ("Sam Jones") can be tried.
const WORD = String.raw`[\p{L}][\p{L}'’-]*`;
const MARKER = new RegExp(
  String.raw`(?:(?<=^|[\s(,])@|\bfor\s+)(${WORD}(?:\s+${WORD}){0,2})`,
  'giu',
);

const fold = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

export interface AssigneeFound extends Span {
  member: QuickAddMember;
}

/** The one member `name` identifies: the full name, or the first name when that is unique. */
function memberNamed(name: string, members: readonly QuickAddMember[]): QuickAddMember | null {
  const wanted = fold(name);
  const full = members.filter((m) => fold(m.name) === wanted);
  if (full.length > 0) return full.length === 1 ? (full[0] as QuickAddMember) : null;
  const first = members.filter((m) => fold(m.name).split(' ')[0] === wanted);
  return first.length === 1 ? (first[0] as QuickAddMember) : null;
}

/**
 * "@Sam" or "for Sam", matched case-insensitively against the members' full or first names. The
 * first marker that names exactly one member wins; an unknown name ("for mum") or an ambiguous
 * first name matches nobody and stays in the title.
 */
export function findAssignee(
  text: string,
  members: readonly QuickAddMember[],
): AssigneeFound | null {
  for (const match of text.matchAll(MARKER)) {
    const captured = match[1] as string;
    const captureStart = match.index + match[0].length - captured.length;
    const words = captured.split(/\s+/);
    // Longest candidate first, so "for Sam Jones on Friday" tries "Sam Jones on", "Sam Jones", "Sam".
    for (let count = words.length; count >= 1; count--) {
      const member = memberNamed(words.slice(0, count).join(' '), members);
      if (!member) continue;
      const named = new RegExp(String.raw`^(?:\S+\s+){${count - 1}}\S+`).exec(
        captured,
      ) as RegExpExecArray;
      return { start: match.index, end: captureStart + named[0].length, member };
    }
  }
  return null;
}
