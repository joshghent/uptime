import { dayRange, type State } from "./check.ts";
import type { Config } from "./config.ts";
import * as db from "./db.ts";
import type { Incident } from "./db.ts";
import { VERSION } from "./version.ts";

export const WINDOW_DAYS = 90;

/** `none` means no checks ran that day — grey, not green. */
export type DayState = "up" | "degraded" | "down" | "none";

export type Day = { day: string; state: DayState; ok: number; fail: number; degraded: number };

export type MonitorStatus = {
  id: string;
  name: string;
  description?: string;
  type: "http" | "heartbeat";
  state: State;
  /** Fraction 0–1 over the window, or null when nothing was ever recorded. */
  uptime: number | null;
  days: Day[];
  lastCheck: number | null;
  lastError: string | null;
  incident: Incident | null;
};

export type Status = {
  title: string;
  description?: string;
  link?: string;
  /** Which release produced this page, so a bug report can name it. */
  version: string;
  generatedAt: number;
  windowDays: number;
  overall: State;
  monitors: MonitorStatus[];
  incidents: Incident[];
};

function dayState(row: { ok: number; fail: number; degraded: number } | undefined): DayState {
  if (!row || row.ok + row.fail === 0) return "none";
  if (row.fail > 0) return "down";
  if (row.degraded > 0) return "degraded";
  return "up";
}

const RANK: Record<State, number> = { unknown: 0, up: 1, degraded: 2, down: 3 };

export async function buildStatus(d1: D1Database, config: Config, now: number): Promise<Status> {
  const days = dayRange(now, WINDOW_DAYS);
  const [rows, last, open, incidents] = await Promise.all([
    db.dailySince(d1, days[0]!),
    db.lastSamples(d1, config.monitors.map((m) => m.id)),
    db.openIncidents(d1),
    db.recentIncidents(d1, now - WINDOW_DAYS * 86400),
  ]);

  const byMonitor = new Map<string, Map<string, db.DailyRow>>();
  for (const r of rows) {
    let m = byMonitor.get(r.monitor);
    if (!m) byMonitor.set(r.monitor, (m = new Map()));
    m.set(r.day, r);
  }

  const monitors = config.monitors.map((m): MonitorStatus => {
    const perDay = byMonitor.get(m.id) ?? new Map<string, db.DailyRow>();
    const series = days.map((day) => {
      const row = perDay.get(day);
      return {
        day,
        state: dayState(row),
        ok: row?.ok ?? 0,
        fail: row?.fail ?? 0,
        degraded: row?.degraded ?? 0,
      };
    });
    const ok = series.reduce((n, d) => n + d.ok, 0);
    const total = ok + series.reduce((n, d) => n + d.fail, 0);
    const l = last.get(m.id);
    const incident = open.get(m.id) ?? null;

    let state: State = "unknown";
    if (incident) state = "down";
    else if (l) state = l.ok === 0 || l.degraded === 1 ? "degraded" : "up";

    return {
      id: m.id,
      name: m.name,
      description: m.description,
      type: m.type,
      state,
      uptime: total === 0 ? null : ok / total,
      days: series,
      lastCheck: l?.ts ?? null,
      lastError: l?.error ?? null,
      incident,
    };
  });

  const overall = monitors.reduce<State>((worst, m) => (RANK[m.state] > RANK[worst] ? m.state : worst), "unknown");

  return {
    title: config.title,
    description: config.description,
    link: config.link,
    version: VERSION,
    generatedAt: now,
    windowDays: WINDOW_DAYS,
    overall,
    monitors,
    incidents,
  };
}
