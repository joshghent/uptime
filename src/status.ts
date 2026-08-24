import { dayKey, dayRange, type State } from "./check.ts";
import type { Config } from "./config.ts";
import * as db from "./db.ts";
import type { Incident } from "./db.ts";
import { VERSION } from "./version.ts";

export const WINDOW_DAYS = 90;

/**
 * How many events each monitor contributes, newest first.
 *
 * Per monitor rather than in total, because the history can be filtered to one
 * service: a global cap would let one noisy monitor push every other service's
 * history off the page.
 */
export const EVENT_LIMIT = 50;

/** `none` means no checks ran that day — grey, not green. */
export type DayState = "up" | "degraded" | "down" | "none";

export type Day = { day: string; state: DayState; ok: number; fail: number; degraded: number };

/**
 * One line of history.
 *
 * `incident` rows come from the incidents table — a monitor that met its alarm
 * rule. The other two come from the daily rollups, and exist because a red or
 * amber bar does not need an incident behind it: a single failed check colours
 * the day red, and a slow-but-passing check colours it amber, while neither on
 * its own trips `failures_before_alarm`. Without these the page showed colours
 * it could not explain.
 */
export type EventKind = "incident" | "outage" | "degraded";

export type StatusEvent = {
  monitor: string;
  /** The monitor's display name, so a consumer needn't join on the id. */
  name: string;
  kind: EventKind;
  /** Unix seconds. Incident start, or 00:00 UTC for a rollup day. */
  at: number;
  /** Incident end, `null` while open and always `null` for rollup days. */
  until: number | null;
  /** `YYYY-MM-DD` for a rollup day, `null` for an incident. */
  day: string | null;
  reason: string;
};

export type MonitorStatus = {
  id: string;
  name: string;
  description?: string;
  type: "http" | "heartbeat";
  state: State;
  /** Fraction 0–1 over the days that have data, or null when nothing was ever recorded. */
  uptime: number | null;
  /**
   * How many days in the window actually recorded a check. `uptime` is measured
   * over these, not over `windowDays` — a monitor added on Tuesday is not at 3%
   * because the other 87 days predate it.
   */
  observedDays: number;
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
  /** Incidents plus the bad days no incident covers, newest first. */
  events: StatusEvent[];
};

function dayState(row: { ok: number; fail: number; degraded: number } | undefined): DayState {
  if (!row || row.ok + row.fail === 0) return "none";
  if (row.fail > 0) return "down";
  if (row.degraded > 0) return "degraded";
  return "up";
}

const RANK: Record<State, number> = { unknown: 0, up: 1, degraded: 2, down: 3 };

/** Midnight UTC of a `YYYY-MM-DD` key, in unix seconds. */
export function dayStart(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The days an incident touches, so the rollup rows for those days can be left
 * out — the incident already says what happened. Bounded by the window: an
 * incident that has been open for a year must not spin through 365 keys.
 */
function incidentDays(i: Incident, now: number, windowStart: number): string[] {
  const from = Math.max(i.started_at, windowStart);
  const to = Math.min(i.resolved_at ?? now, now);
  const days: string[] = [];
  for (let t = from; t <= to + 86400 && days.length <= WINDOW_DAYS; t += 86400) {
    const key = dayKey(t);
    if (key > dayKey(to)) break;
    days.push(key);
  }
  return days;
}

function rollupEvent(m: MonitorStatus, d: Day): StatusEvent | null {
  const base = { monitor: m.id, name: m.name, at: dayStart(d.day), until: null, day: d.day };
  if (d.fail > 0) {
    return {
      ...base,
      kind: "outage",
      reason: `${plural(d.fail, "check")} of ${d.ok + d.fail} failed`,
    };
  }
  if (d.degraded > 0) {
    return {
      ...base,
      kind: "degraded",
      reason: `${plural(d.degraded, "check")} of ${d.ok} slower than the degraded threshold`,
    };
  }
  return null;
}

export async function buildStatus(d1: D1Database, config: Config, now: number): Promise<Status> {
  const days = dayRange(now, WINDOW_DAYS);
  const windowStart = dayStart(days[0]!);
  const [rows, last, open, incidents] = await Promise.all([
    db.dailySince(d1, days[0]!),
    db.lastSamples(d1, config.monitors.map((m) => m.id)),
    db.openIncidents(d1),
    db.recentIncidents(d1, windowStart, EVENT_LIMIT),
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
      observedDays: series.reduce((n, d) => n + (d.state === "none" ? 0 : 1), 0),
      days: series,
      lastCheck: l?.ts ?? null,
      lastError: l?.error ?? null,
      incident,
    };
  });

  return {
    title: config.title,
    description: config.description,
    link: config.link,
    version: VERSION,
    generatedAt: now,
    windowDays: WINDOW_DAYS,
    overall: monitors.reduce<State>((worst, m) => (RANK[m.state] > RANK[worst] ? m.state : worst), "unknown"),
    monitors,
    incidents,
    events: buildEvents(monitors, incidents, open, now, windowStart),
  };
}

function buildEvents(
  monitors: MonitorStatus[],
  incidents: Incident[],
  open: Map<string, Incident>,
  now: number,
  windowStart: number,
): StatusEvent[] {
  const names = new Map(monitors.map((m) => [m.id, m.name]));

  // An incident that started before the window is missing from `incidents` but
  // is still the reason today's bar is red, so the open ones are folded in.
  const all = new Map<number, Incident>();
  for (const i of [...incidents, ...open.values()]) all.set(i.id, i);

  const covered = new Set<string>();
  const events: StatusEvent[] = [];
  for (const i of all.values()) {
    for (const day of incidentDays(i, now, windowStart)) covered.add(`${i.monitor}|${day}`);
    events.push({
      monitor: i.monitor,
      name: names.get(i.monitor) ?? i.monitor,
      kind: "incident",
      at: i.started_at,
      until: i.resolved_at,
      day: null,
      reason: i.reason,
    });
  }

  for (const m of monitors) {
    for (const d of m.days) {
      if (covered.has(`${m.id}|${d.day}`)) continue;
      const e = rollupEvent(m, d);
      if (e) events.push(e);
    }
  }

  // Newest first. An incident and a rollup day can share a timestamp only when
  // an incident opened exactly at midnight; the incident is the better row, so
  // it wins the tie.
  events.sort((a, b) => b.at - a.at || (a.kind === "incident" ? -1 : b.kind === "incident" ? 1 : 0));

  const kept = new Map<string, number>();
  return events.filter((e) => {
    const n = (kept.get(e.monitor) ?? 0) + 1;
    kept.set(e.monitor, n);
    return n <= EVENT_LIMIT;
  });
}
