// Fails if the Drizzle schema has changes that are not captured in migrations/, or if the
// migrations are internally inconsistent. Generates into a temp copy, so nothing is written
// to the repo.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const sqlFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.sql'));
const kit = (...args) => {
  // drizzle-kit can print an error and still exit 0, so also read what it printed.
  const output = execFileSync('pnpm', ['exec', 'drizzle-kit', ...args], { encoding: 'utf8' });
  process.stdout.write(output);
  return output;
};

kit('check');

const tmp = mkdtempSync(join(tmpdir(), 'db-drift-'));
try {
  cpSync('migrations', tmp, { recursive: true });
  const before = sqlFiles(tmp).length;
  // drizzle-kit prefixes --out with "./", so it must be a relative path.
  const out = kit(
    'generate',
    '--dialect',
    'postgresql',
    '--schema',
    './src/schema/index.ts',
    '--out',
    relative(process.cwd(), tmp),
  );
  if (sqlFiles(tmp).length !== before) {
    console.error(
      '\nSchema changed without a migration. Run `pnpm db:generate --name <change>` and commit the result.',
    );
    process.exitCode = 1;
  } else if (!out.includes('No schema changes')) {
    console.error('\nUnexpected drizzle-kit output; could not confirm the schema is in sync.');
    process.exitCode = 1;
  } else {
    console.log('No schema drift.');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
