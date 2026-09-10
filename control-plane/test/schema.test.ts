import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Schema-drift guard.
 *
 * The unit tests run against an in-memory store, so a column the D1 store selects
 * but the migrations never create is invisible to them — it surfaces as a runtime
 * "no such column" error against real D1 (which is exactly how it was found). This
 * test reads the migrations and fails as soon as the two disagree.
 */

// vitest runs with the package root as cwd; avoiding __dirname keeps this file
// valid under both CJS and ESM transforms.
const packageRoot = process.cwd();
const migrationsDir = join(packageRoot, 'migrations');
const storeSource = readFileSync(join(packageRoot, 'src', 'd1-store.ts'), 'utf8');

/** Column list of each table as the migrations build it (CREATE + later ALTERs). */
function tableColumns(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    // Strip comments so a commented-out column cannot count as schema.
    const stripped = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');

    for (const match of stripped.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
      const [, table, body] = match;
      const columns = tables.get(table!) ?? new Set<string>();
      for (const rawLine of (body ?? '').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('--')) continue;
        // Skip table-level constraints; keep real column definitions.
        if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(line)) continue;
        const name = /^"?(\w+)"?/.exec(line)?.[1];
        if (name) columns.add(name);
      }
      tables.set(table!, columns);
    }

    // A rebuild (CREATE new + RENAME) replaces the old column set; without this a
    // rebuilt table would leave the guard validating a table that no longer exists.
    for (const match of stripped.matchAll(/ALTER TABLE\s+(\w+)\s+RENAME TO\s+"?(\w+)"?/gi)) {
      const [, from, to] = match;
      const columns = tables.get(from!);
      if (columns) {
        tables.set(to!, columns);
        tables.delete(from!);
      }
    }

    for (const match of stripped.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+"?(\w+)"?/gi)) {
      const [, table, column] = match;
      const columns = tables.get(table!) ?? new Set<string>();
      columns.add(column!);
      tables.set(table!, columns);
    }
  }

  return tables;
}

/** `const NAME_COLUMNS = \`a, b, c\`;` in the D1 store. */
function selectedColumns(): Array<{ name: string; columns: string[] }> {
  const found: Array<{ name: string; columns: string[] }> = [];
  for (const match of storeSource.matchAll(/const\s+(\w+_COLUMNS)\s*=\s*`([^`]+)`/g)) {
    const [, name, list] = match;
    found.push({
      name: name!,
      columns: (list ?? '')
        .split(',')
        .map((column) => column.trim().split(/\s+/)[0] ?? '')
        .filter(Boolean),
    });
  }
  return found;
}

const TABLE_FOR_CONSTANT: Record<string, string> = {
  SLOT_COLUMNS: 'slot_occurrences',
  EXECUTION_COLUMNS: 'executions',
  REVIEW_COLUMNS: 'reviews',
};

describe('D1 store selects only columns the migrations create', () => {
  const tables = tableColumns();
  const selections = selectedColumns();

  it('finds the migrations and the column constants', () => {
    expect(tables.size).toBeGreaterThanOrEqual(5);
    expect(selections.length).toBeGreaterThanOrEqual(3);
  });

  for (const [constant, table] of Object.entries(TABLE_FOR_CONSTANT)) {
    it(`${constant} matches ${table}`, () => {
      const selection = selections.find((entry) => entry.name === constant);
      expect(selection, `${constant} not found in d1-store.ts`).toBeDefined();
      const columns = tables.get(table);
      expect(columns, `${table} not found in migrations`).toBeDefined();
      const missing = selection!.columns.filter((column) => !columns!.has(column));
      expect(missing, `${constant} selects columns missing from ${table}`).toEqual([]);
    });
  }

  it('the reviews table carries the fields the adapter relies on', () => {
    const reviews = tables.get('reviews')!;
    for (const column of ['last_error', 'message_ids', 'publish_chat_id', 'publish_thread_id', 'caption']) {
      expect(reviews.has(column), `reviews.${column} missing`).toBe(true);
    }
  });
});
