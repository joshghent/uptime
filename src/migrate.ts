import init from "../migrations/0001_init.sql";
import pruneIndex from "../migrations/0002_prune_index.sql";

/**
 * Every migration, oldest first, bundled into the Worker as text. A deployment
 * applies these itself on first use, so an update that adds one needs nothing
 * from whoever runs the page — no deploy command, no `migrations apply`.
 *
 * Adding a migration means adding the file and a line here.
 * `test/migrations.test.ts` fails if this list drifts from `migrations/`.
 */
export const MIGRATIONS: { name: string; sql: string }[] = [
  { name: "0001_init.sql", sql: init },
  { name: "0002_prune_index.sql", sql: pruneIndex },
];

/**
 * wrangler's own ledger, created the way `wrangler d1 migrations apply`
 * creates it. Sharing it means a database migrated by wrangler before this
 * existed is recognised as up to date, and wrangler still agrees afterwards.
 */
const LEDGER = `CREATE TABLE IF NOT EXISTS d1_migrations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/**
 * One statement per entry, which is what `D1Database.batch` takes. Comments
 * are stripped first so a `;` in one cannot split a statement — which also
 * means a migration must not put `;` or `--` inside a string literal.
 */
export function statements(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function appliedNames(db: D1Database): Promise<Set<string>> {
  const [, rows] = await db.batch<{ name: string }>([
    db.prepare(LEDGER),
    db.prepare(`SELECT name FROM d1_migrations`),
  ]);
  return new Set(rows!.results.map((r) => r.name));
}

/**
 * Brings the schema up to date. Each migration runs in one batch together with
 * its ledger row, and a batch is a transaction, so a migration is either fully
 * applied and recorded or not at all.
 *
 * Two isolates can start at once and race here. The loser's batch fails — its
 * CREATE hits the table the winner just made, or its ledger row hits the
 * UNIQUE name — and rolls back. That is only an error if the migration is
 * still missing afterwards.
 */
export async function migrate(db: D1Database): Promise<void> {
  const applied = await appliedNames(db);
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue;
    try {
      await db.batch([
        ...statements(m.sql).map((s) => db.prepare(s)),
        db.prepare(`INSERT INTO d1_migrations (name) VALUES (?)`).bind(m.name),
      ]);
    } catch (e) {
      if (!(await appliedNames(db)).has(m.name)) throw e;
    }
  }
}
