import type { ZodType } from 'zod';

export type FieldErrors = Record<string, string>;

/**
 * Checks form values against one of the shared zod schemas (the same rules the api enforces) and
 * returns one message per field, or `null` when valid. A blank field is reported as "Required"
 * rather than zod's technical "too small" wording.
 */
export function validateForm(schema: ZodType, values: Record<string, unknown>): FieldErrors | null {
  const result = schema.safeParse(values);
  if (result.success) return null;
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? '');
    if (field === '' || field in errors) continue;
    const value = values[field];
    errors[field] = issue.code === 'too_small' && value === '' ? 'Required' : issue.message;
  }
  return errors;
}

/** Password + confirmation: the one rule the api cannot check. */
export function confirmationError(password: string, confirmation: string): string | undefined {
  return password === confirmation ? undefined : 'The passwords do not match';
}
