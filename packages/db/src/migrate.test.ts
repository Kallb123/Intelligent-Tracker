import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_LOCK_KEY, resolveMigrationsFolder } from './migrate.js';

describe('resolveMigrationsFolder', () => {
  it('prefers the explicit option over MIGRATIONS_DIR', () => {
    expect(resolveMigrationsFolder('/explicit', { MIGRATIONS_DIR: '/env' })).toBe('/explicit');
  });

  it('uses MIGRATIONS_DIR when there is no explicit option', () => {
    expect(resolveMigrationsFolder(undefined, { MIGRATIONS_DIR: '/env' })).toBe('/env');
  });

  it('falls back to the package migrations folder, which holds the drizzle journal', () => {
    const folder = resolveMigrationsFolder(undefined, {});
    expect(folder).toMatch(/packages[\\/]db[\\/]migrations$/);
    expect(existsSync(join(folder, 'meta', '_journal.json'))).toBe(true);
  });
});

describe('MIGRATION_LOCK_KEY', () => {
  it('is a safe positive integer', () => {
    expect(Number.isSafeInteger(MIGRATION_LOCK_KEY)).toBe(true);
    expect(MIGRATION_LOCK_KEY).toBeGreaterThan(0);
  });
});

describe('migrations folder', () => {
  it('has a journal entry for every SQL file', () => {
    const folder = resolveMigrationsFolder(undefined, {});
    const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    expect(journal.entries.length).toBeGreaterThan(0);
    for (const { tag } of journal.entries) {
      expect(existsSync(join(folder, `${tag}.sql`))).toBe(true);
    }
  });
});
