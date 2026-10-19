import { z } from 'zod';

export const SUGGESTION_KINDS = ['lateness', 'snoozes', 'fairness'] as const;
export const suggestionIdSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const suggestionSchema = z.object({
  id: suggestionIdSchema,
  taskId: z.uuid(),
  title: z.string(),
  kind: z.enum(SUGGESTION_KINDS),
  message: z.string(),
});
export const suggestionsResponseSchema = z.object({ suggestions: z.array(suggestionSchema) });
export const suggestionActionSchema = z.object({ action: z.enum(['accept', 'dismiss']) });
export type SuggestionDto = z.infer<typeof suggestionSchema>;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];
export type SuggestionAction = z.infer<typeof suggestionActionSchema>['action'];
