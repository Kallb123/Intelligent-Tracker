/** The Postgres error behind a failed query (Drizzle wraps it as `cause`). */
function pgError(err: unknown): { code?: string; constraint_name?: string } {
  const cause = (err as { cause?: unknown } | null)?.cause ?? err;
  return (cause ?? {}) as { code?: string; constraint_name?: string };
}

/** The violated unique index/constraint name, or undefined if `err` is not a unique violation. */
export function uniqueViolation(err: unknown): string | undefined {
  const { code, constraint_name } = pgError(err);
  return code === '23505' ? (constraint_name ?? '') : undefined;
}
