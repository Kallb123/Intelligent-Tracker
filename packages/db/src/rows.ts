/** The single row an insert/update `returning()` is known to produce. */
export function one<T>(rows: readonly T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected a row but the query returned none');
  return row;
}
