import { createDb, runMigrations, seedReferenceData, type MigrationLogger } from '@tracker/db';

/** Applies pending migrations, then (idempotently) seeds reference data such as bank holidays. */
export async function prepareDatabase(databaseUrl: string, logger: MigrationLogger): Promise<void> {
  await runMigrations({ databaseUrl, logger });
  const { db, close } = createDb(databaseUrl, { max: 1 });
  try {
    const { bankHolidays } = await seedReferenceData(db);
    logger.info(`reference data seeded (${bankHolidays} bank holidays)`);
  } finally {
    await close();
  }
}
