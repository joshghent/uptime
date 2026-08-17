import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrationApplied } from "../src/db.ts";
import { LATEST_MIGRATION } from "../src/version.ts";

// The Worker cannot list `migrations/` at runtime — the directory is not
// bundled — so LATEST_MIGRATION is written down by hand. These tests are what
// stop it from drifting: add a migration without updating the constant and the
// suite fails here, rather than on someone's fork three releases later.
describe("LATEST_MIGRATION", () => {
  it("names the newest file in migrations/", () => {
    const names = env.TEST_MIGRATIONS.map((m) => m.name);
    expect(names).toContain(LATEST_MIGRATION);
    expect(names[names.length - 1]).toBe(LATEST_MIGRATION);
  });

  it("is applied to a database the migrations have run against", async () => {
    expect(await migrationApplied(env.DB, LATEST_MIGRATION)).toBe(true);
  });

  it("reports a migration this database has never seen", async () => {
    expect(await migrationApplied(env.DB, "9999_not_applied.sql")).toBe(false);
  });
});
