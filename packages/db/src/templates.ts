import { UK_TEMPLATES, type Template } from '@tracker/shared';
import { asc, eq } from 'drizzle-orm';
import type { DbOrTransaction } from './client.js';
import { template } from './schema/index.js';

/**
 * The templates a household can use: the built-in UK pack, then its own by title. This is what
 * `GET /api/templates` lists and what the quick-add parser matches keywords against.
 */
export async function listTemplates(db: DbOrTransaction, householdId: string): Promise<Template[]> {
  const rows = await db
    .select()
    .from(template)
    .where(eq(template.householdId, householdId))
    .orderBy(asc(template.title), asc(template.id));
  return [...UK_TEMPLATES, ...rows.map((row) => ({ ...row, builtIn: false }))];
}
