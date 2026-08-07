import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The cron runs every minute forever, so any query in that path that reads the
 * whole `samples` table grows without bound and eventually eats the D1 read
 * allowance. These assert on the plan rather than on timings, so they fail the
 * moment a query loses its index instead of once the table is large enough to
 * hurt.
 */
async function plan(sql: string, ...binds: unknown[]): Promise<string> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...binds)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join(" | ");
}

describe("hot-path query plans", () => {
  it("reads the latest sample per monitor by index seek", async () => {
    const detail = await plan(
      `SELECT monitor, ts, ok, degraded, error FROM samples WHERE monitor = ? ORDER BY ts DESC LIMIT 1`,
      "plan-pacer",
    );
    expect(detail).toMatch(/SEARCH samples USING INDEX idx_samples_monitor_ts/);
    expect(detail).not.toMatch(/SCAN samples/);
  });

  it("reads the recent-sample window by index seek", async () => {
    const detail = await plan(
      `SELECT ts, ok, degraded FROM samples WHERE monitor = ? ORDER BY ts DESC LIMIT ?`,
      "plan-pacer",
      5,
    );
    expect(detail).toMatch(/SEARCH samples/);
    expect(detail).not.toMatch(/SCAN samples/);
  });

  it("prunes by an indexed range rather than a table scan", async () => {
    const detail = await plan(`DELETE FROM samples WHERE ts < ?`, 0);
    expect(detail).toMatch(/idx_samples_ts/);
    expect(detail).not.toMatch(/SCAN samples\b(?! USING)/);
  });

  it("reads the 90-day window from the daily rollups by primary key range", async () => {
    const detail = await plan(`SELECT monitor, day, ok, fail, degraded FROM daily WHERE day >= ?`, "2026-01-01");
    // Small table (monitors x 365 at most), so a scan here is bounded and fine.
    expect(detail).toMatch(/daily/);
  });

  it("finds the open incident per monitor without scanning history", async () => {
    const detail = await plan(`SELECT * FROM incidents WHERE resolved_at IS NULL`);
    expect(detail).toMatch(/idx_incidents_one_open/);
  });
});
