import { checkHeartbeat, dayKey, evaluate, runHttpCheck, type Sample, type State } from "./check.ts";
import type { Config, Monitor } from "./config.ts";
import * as db from "./db.ts";
import { notify } from "./notify.ts";

export type RunResult = {
  monitor: string;
  state: State;
  sample: Sample;
  transition?: "opened" | "resolved";
};

/** How many recent samples the alarm rules need to see. */
function windowSize(m: Monitor): number {
  const byCount = (m.failuresBeforeAlarm ?? 1) + 1;
  const byDuration = m.failingFor ? Math.ceil(m.failingFor / m.interval) + 2 : 0;
  return Math.min(200, Math.max(5, byCount, byDuration));
}

/**
 * One cron tick: check every monitor whose interval has elapsed, record the
 * result, open or resolve its incident, and notify on the transition.
 *
 * Monitors are independent — one that throws is logged and the rest continue.
 */
export async function runChecks(
  d1: D1Database,
  config: Config,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RunResult[]> {
  const ids = config.monitors.map((m) => m.id);
  const [last, open, heartbeats] = await Promise.all([
    db.lastSamples(d1, ids),
    db.openIncidents(d1),
    db.getHeartbeats(d1),
  ]);

  // A cron minute never lands exactly on the interval boundary, so a 60s
  // monitor checked at :00.4 would be skipped at :00.9 and run every other
  // minute. The slack makes "due" mean "due within this tick".
  const slack = 5;
  const due = config.monitors.filter((m) => {
    const at = last.get(m.id)?.ts;
    return at === undefined || now - at >= m.interval - slack;
  });

  const settled = await Promise.allSettled(
    due.map((m) => checkOne(d1, m, now, open.has(m.id), heartbeats.get(m.id) ?? null, fetchImpl)),
  );

  const results: RunResult[] = [];
  settled.forEach((r, i) => {
    if (r.status === "rejected") console.error(`monitor ${due[i]!.id} failed:`, r.reason);
    else if (r.value) results.push(r.value);
  });

  // Hourly, not every tick. Retention is a housekeeping job; running it 1,440
  // times a day to delete the same nothing is pure cost.
  if (Math.floor(now / 60) % 60 === 0) {
    await db.pruneSamples(d1, now - config.retainDays * 86400);
    await db.pruneDaily(d1, dayKey(now - 365 * 86400));
  }
  return results;
}

async function checkOne(
  d1: D1Database,
  m: Monitor,
  now: number,
  hasOpenIncident: boolean,
  lastPing: number | null,
  fetchImpl: typeof fetch,
): Promise<RunResult | null> {
  const sample =
    m.type === "http" ? await runHttpCheck(m, fetchImpl) : checkHeartbeat(m, lastPing, now);
  // A heartbeat that has never been pinged has no data yet.
  if (sample === null) return null;

  await db.recordSample(d1, m.id, now, sample);
  const recent = await db.recentSamples(d1, m.id, windowSize(m));
  const state = evaluate(m, recent, now);

  if (state === "down" && !hasOpenIncident) {
    const reason = sample.error ?? "failing";
    await db.openIncident(d1, m.id, now, reason);
    report(await notify({ monitor: m, event: "down", reason, at: now }, fetchImpl), m.id);
    return { monitor: m.id, state, sample, transition: "opened" };
  }
  if (state !== "down" && hasOpenIncident) {
    await db.resolveIncident(d1, m.id, now);
    report(await notify({ monitor: m, event: "up", reason: "back to normal", at: now }, fetchImpl), m.id);
    return { monitor: m.id, state, sample, transition: "resolved" };
  }
  return { monitor: m.id, state, sample };
}

function report(errors: Error[], id: string) {
  for (const e of errors) console.error(`notify for ${id} failed:`, e.message);
}
