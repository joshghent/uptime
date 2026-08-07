import type { RecentSample, Sample } from "./check.ts";
import { dayKey } from "./check.ts";

export type Incident = {
  id: number;
  monitor: string;
  started_at: number;
  resolved_at: number | null;
  reason: string;
};

export type DailyRow = { monitor: string; day: string; ok: number; fail: number; degraded: number };

/** Records a sample and rolls it into the day bucket in one round trip. */
export function recordSample(db: D1Database, monitor: string, ts: number, s: Sample) {
  const ok = s.ok ? 1 : 0;
  const degraded = s.ok && s.degraded ? 1 : 0;
  return db.batch([
    db
      .prepare(
        `INSERT INTO samples (monitor, ts, ok, degraded, status, latency_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(monitor, ts, ok, degraded, s.status, s.latencyMs, s.error),
    db
      .prepare(
        `INSERT INTO daily (monitor, day, ok, fail, degraded) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (monitor, day) DO UPDATE SET
           ok = ok + excluded.ok,
           fail = fail + excluded.fail,
           degraded = degraded + excluded.degraded`,
      )
      .bind(monitor, dayKey(ts), ok, ok ? 0 : 1, degraded),
  ]);
}

/** Newest first. */
export async function recentSamples(db: D1Database, monitor: string, limit: number): Promise<RecentSample[]> {
  const { results } = await db
    .prepare(`SELECT ts, ok, degraded FROM samples WHERE monitor = ? ORDER BY ts DESC LIMIT ?`)
    .bind(monitor, limit)
    .all<RecentSample>();
  return results;
}

export type LastSample = RecentSample & { monitor: string; error: string | null };

/**
 * Most recent sample per monitor, for "last checked", the card's error line and
 * the due-check gate.
 *
 * One `LIMIT 1` per monitor rather than `MAX(ts) ... GROUP BY monitor`. The
 * grouped form reads every row in the table — at a one-minute interval that is
 * ~10k rows per monitor per day, on a query that runs every single cron tick.
 * Each of these is an index seek that touches one row.
 */
export async function lastSamples(db: D1Database, monitors: string[]): Promise<Map<string, LastSample>> {
  if (monitors.length === 0) return new Map();
  const stmt = db.prepare(
    `SELECT monitor, ts, ok, degraded, error FROM samples WHERE monitor = ? ORDER BY ts DESC LIMIT 1`,
  );
  const rows = await db.batch<LastSample>(monitors.map((m) => stmt.bind(m)));
  return new Map(rows.flatMap((r) => r.results).map((r) => [r.monitor, r]));
}

export async function dailySince(db: D1Database, sinceDay: string): Promise<DailyRow[]> {
  const { results } = await db
    .prepare(`SELECT monitor, day, ok, fail, degraded FROM daily WHERE day >= ? ORDER BY day ASC`)
    .bind(sinceDay)
    .all<DailyRow>();
  return results;
}

export async function openIncidents(db: D1Database): Promise<Map<string, Incident>> {
  const { results } = await db
    .prepare(`SELECT * FROM incidents WHERE resolved_at IS NULL`)
    .all<Incident>();
  return new Map(results.map((i) => [i.monitor, i]));
}

export async function recentIncidents(db: D1Database, since: number, limit = 20): Promise<Incident[]> {
  const { results } = await db
    .prepare(`SELECT * FROM incidents WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?`)
    .bind(since, limit)
    .all<Incident>();
  return results;
}

/** No-op when an incident is already open — the partial unique index guards it. */
export function openIncident(db: D1Database, monitor: string, at: number, reason: string) {
  return db
    .prepare(
      `INSERT INTO incidents (monitor, started_at, reason) VALUES (?, ?, ?)
       ON CONFLICT (monitor) WHERE resolved_at IS NULL DO NOTHING`,
    )
    .bind(monitor, at, reason)
    .run();
}

export function resolveIncident(db: D1Database, monitor: string, at: number) {
  return db
    .prepare(`UPDATE incidents SET resolved_at = ? WHERE monitor = ? AND resolved_at IS NULL`)
    .bind(at, monitor)
    .run();
}

export async function getHeartbeat(db: D1Database, monitor: string): Promise<number | null> {
  const row = await db
    .prepare(`SELECT last_ping FROM heartbeats WHERE monitor = ?`)
    .bind(monitor)
    .first<{ last_ping: number }>();
  return row?.last_ping ?? null;
}

export async function getHeartbeats(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(`SELECT monitor, last_ping FROM heartbeats`)
    .all<{ monitor: string; last_ping: number }>();
  return new Map(results.map((r) => [r.monitor, r.last_ping]));
}

export function recordPing(db: D1Database, monitor: string, at: number) {
  return db
    .prepare(
      `INSERT INTO heartbeats (monitor, last_ping) VALUES (?, ?)
       ON CONFLICT (monitor) DO UPDATE SET last_ping = excluded.last_ping`,
    )
    .bind(monitor, at)
    .run();
}

export function pruneSamples(db: D1Database, before: number) {
  return db.prepare(`DELETE FROM samples WHERE ts < ?`).bind(before).run();
}

/** The page only reads 90 days; a year of rollups is plenty of headroom. */
export function pruneDaily(db: D1Database, beforeDay: string) {
  return db.prepare(`DELETE FROM daily WHERE day < ?`).bind(beforeDay).run();
}
