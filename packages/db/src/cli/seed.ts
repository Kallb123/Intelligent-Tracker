import { createDb } from '../client.js';
import { seedDemoHousehold, seedReferenceData } from '../seed/index.js';
import { requireDatabaseUrl } from './env.js';

// Seeds reference data (and, with --demo, a "Home" household). Assumes the database is already
// migrated (pnpm db:migrate). Usage: DATABASE_URL=... pnpm db:seed [--demo]
// (`pnpm db:seed -- --demo` forwards a literal `--`, which parseArgs would treat as end-of-options.)
const demo = process.argv.includes('--demo');

const { db, close } = createDb(requireDatabaseUrl());
try {
  const reference = await seedReferenceData(db);
  console.log(`bank holidays upserted: ${reference.bankHolidays}`);
  if (demo) {
    const created = await seedDemoHousehold(db);
    console.log(
      created ? `created household "${created.name}" (${created.id})` : 'household already exists',
    );
  }
} finally {
  await close();
}
