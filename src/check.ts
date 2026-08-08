import type { Monitor } from "./config.ts";

export type Sample = {
  ok: boolean;
  degraded: boolean;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
};

/** Newest first. */
export type RecentSample = { ts: number; ok: number; degraded: number };

export type State = "up" | "degraded" | "down" | "unknown";

export function statusMatches(expect: number[] | string, status: number): boolean {
  if (typeof expect === "string") return Math.floor(status / 100) === Number(expect[0]);
  return expect.includes(status);
}

/** Runs one HTTP monitor. Network and timeout failures become failed samples, not throws. */
export async function runHttpCheck(
  m: Extract<Monitor, { type: "http" }>,
  fetchImpl: typeof fetch = fetch,
): Promise<Sample> {
  const started = Date.now();
  try {
    const res = await fetchImpl(m.url, {
      method: m.method,
      headers: m.headers,
      body: m.body,
      signal: AbortSignal.timeout(m.timeout * 1000),
      redirect: "follow",
    });
    // Read the body before measuring, otherwise latency excludes transfer time.
    const text = m.expectBody ? await res.text() : "";
    const latencyMs = Date.now() - started;

    if (!statusMatches(m.expectStatus, res.status)) {
      return { ok: false, degraded: false, status: res.status, latencyMs, error: `unexpected status ${res.status}` };
    }
    if (m.expectBody && !text.includes(m.expectBody)) {
      return {
        ok: false,
        degraded: false,
        status: res.status,
        latencyMs,
        error: `body did not contain ${JSON.stringify(m.expectBody)}`,
      };
    }
    return {
      ok: true,
      degraded: m.degradedMs !== undefined && latencyMs > m.degradedMs,
      status: res.status,
      latencyMs,
      error: null,
    };
  } catch (e) {
    const err = e as Error;
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    return {
      ok: false,
      degraded: false,
      status: null,
      latencyMs: Date.now() - started,
      error: timedOut ? `timed out after ${m.timeout}s` : `${err.name}: ${err.message}`,
    };
  }
}

/**
 * Turns a heartbeat's last ping into a sample. A monitor that has never been
 * pinged is not a failure — it has no data yet, so a fresh deploy does not
 * page you for a job that hasn't had a chance to run.
 */
export function checkHeartbeat(
  m: Extract<Monitor, { type: "heartbeat" }>,
  lastPing: number | null,
  now: number,
): Sample | null {
  if (lastPing === null) return null;
  const age = now - lastPing;
  const deadline = m.period + m.grace;
  if (age <= deadline) return { ok: true, degraded: false, status: null, latencyMs: null, error: null };
  return {
    ok: false,
    degraded: false,
    status: null,
    latencyMs: null,
    // The deadline, not the period — the deadline is what tripped, and naming
    // the period makes the page look like it wants more frequent pings.
    error: `no ping for ${formatDuration(age)}, expected within ${formatDuration(deadline)}`,
  };
}

/**
 * Decides whether a monitor is in alarm, given its most recent samples
 * (newest first, including the one just recorded).
 */
export function evaluate(m: Monitor, recent: RecentSample[], now: number): State {
  if (recent.length === 0) return "unknown";

  let streak = 0;
  while (streak < recent.length && recent[streak]!.ok === 0) streak++;

  if (streak > 0) {
    const oldestFailure = recent[streak - 1]!.ts;
    const byCount = m.failuresBeforeAlarm !== undefined && streak >= m.failuresBeforeAlarm;
    const byDuration = m.failingFor !== undefined && now - oldestFailure >= m.failingFor;
    if (byCount || byDuration) return "down";
    // Failing, but not for long enough to call it. Say so rather than lying green.
    return "degraded";
  }
  return recent[0]!.degraded === 1 ? "degraded" : "up";
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  // Days carry their hours. Whole days alone put a 24h period and its 26h
  // deadline on the same string, which reads as a contradiction.
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** UTC date key, `YYYY-MM-DD`. */
export function dayKey(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** The last `count` day keys ending today, oldest first. */
export function dayRange(now: number, count: number): string[] {
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) days.push(dayKey(now - i * 86400));
  return days;
}
