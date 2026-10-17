import type { Template } from '@tracker/shared';

const words = (text: string): string =>
  ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;

/** Whole words/phrases only: "MOT" matches, "remote" does not. Never applies changes. */
export function suggestTemplates(title: string, templates: readonly Template[]): Template[] {
  const text = words(title);
  return templates
    .map((template, index) => ({
      template,
      index,
      score: Math.max(
        0,
        ...template.keywords
          .map(words)
          // A keyword of only punctuation normalises to blanks and would match an empty title.
          .filter((k) => k.trim() && text.includes(k))
          .map((k) => k.length),
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .map(({ template }) => template);
}
