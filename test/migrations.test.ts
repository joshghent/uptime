import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrationApplied } from "../src/db.ts";
import { createWorker } from "../src/index.ts";
import { MIGRATIONS, migrate, statements } from "../src/migrate.ts";
import { LATEST_MIGRATION } from "../src/version.ts";
import source from "../template/status.yaml";

// The Worker cannot list `migrations/` at runtime — the directory is not
// bundled — so MIGRATIONS is written down by hand. This is what stops it from
// drifting: add a file without the line and the suite fails here, rather than
// on someone's deployment three releases later.
describe("MIGRATIONS", () => {
  it("lists every file in migrations/, in order", () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
  });

  it("ends with LATEST_MIGRATION", () => {
    expect(LATEST_MIGRATION).toBe(env.TEST_MIGRATIONS[env.TEST_MIGRATIONS.length - 1]!.name);
  });
});

describe("statements", () => {
  it("splits on ; and ignores one inside a comment", () => {
    const sql = `-- first; still a comment\nCREATE TABLE a (x INT); -- trailing\n\nCREATE INDEX i ON a (x);\n`;
    expect(statements(sql)).toEqual(["CREATE TABLE a (x INT)", "CREATE INDEX i ON a (x)"]);
  });
});

describe("migrationApplied", () => {
  it("is true for a database the migrations have run against", async () => {
    expect(await migrationApplied(env.DB, LATEST_MIGRATION)).toBe(true);
  });

  it("reports a migration this database has never seen", async () => {
    expect(await migrationApplied(env.DB, "9999_not_applied.sql")).toBe(false);
  });
});

const TABLES = ["samples", "daily", "incidents", "heartbeats", "d1_migrations"];

/** Tables and indexes, as SQLite records them. */
async function schema(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' ORDER BY name`,
  ).all<{ sql: string }>();
  return results.map((r) => r.sql);
}

async function ledger(): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT name FROM d1_migrations ORDER BY id`).all<{ name: string }>();
  return results.map((r) => r.name);
}

async function dropEverything() {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DROP TABLE IF EXISTS ${t}`)));
}

describe("migrate", () => {
  it("builds the same schema from nothing that wrangler's apply does", async () => {
    const expected = await schema();
    await dropEverything();
    await migrate(env.DB);
    expect(await schema()).toEqual(expected);
    expect(await ledger()).toEqual(MIGRATIONS.map((m) => m.name));
  });

  it("does nothing to a database that is already up to date", async () => {
    const before = await ledger();
    await migrate(env.DB);
    expect(await ledger()).toEqual(before);
  });

  it("applies only what is missing from a database wrangler migrated", async () => {
    await env.DB.batch([
      env.DB.prepare(`DROP INDEX idx_samples_ts`),
      env.DB.prepare(`DELETE FROM d1_migrations WHERE name = ?`).bind("0002_prune_index.sql"),
    ]);
    await migrate(env.DB);
    expect(await ledger()).toEqual(MIGRATIONS.map((m) => m.name));
    const index = await env.DB.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_samples_ts'`).first();
    expect(index).not.toBeNull();
  });

  it("survives another isolate migrating between its read and its write", async () => {
    await dropEverything();
    // The first migration batch (more than the ledger's two statements) lets
    // a second migrate() win the race before it goes through.
    let raced = false;
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: D1PreparedStatement[]) => {
            if (!raced && stmts.length > 2) {
              raced = true;
              await migrate(env.DB);
            }
            return target.batch(stmts);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await migrate(racing);
    expect(raced).toBe(true);
    expect(await ledger()).toEqual(MIGRATIONS.map((m) => m.name));
  });
});

describe("a new deployment", () => {
  it("migrates an empty database before serving the page", async () => {
    await dropEverything();
    const worker = createWorker(source);
    const get = async (path: string) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(`https://status.test${path}`), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };

    expect((await get("/")).status).toBe(200);
    expect(await (await get("/health")).json()).toMatchObject({ status: "ok", migrationsApplied: true });
  });
});
