import { applyD1Migrations, env } from "cloudflare:test";

// Runs once outside the per-test storage isolation, so the schema survives
// while each test's writes are rolled back.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
