import { describe, expect, it } from "vitest";
import {
  checkHeartbeat,
  dayKey,
  dayRange,
  evaluate,
  formatDuration,
  runHttpCheck,
  statusMatches,
  type RecentSample,
} from "../src/check.ts";
import { loadConfig, type Monitor } from "../src/config.ts";

function monitor(yaml: string): Monitor {
  return loadConfig(`monitors:\n${yaml}`).monitors[0]!;
}

const http = (extra = "") =>
  monitor(`  - name: A\n    url: https://a.example/health\n${extra}`) as Extract<Monitor, { type: "http" }>;

const heartbeat = (extra = "") =>
  monitor(`  - name: Job\n    type: heartbeat\n    period: 1h\n${extra}`) as Extract<
    Monitor,
    { type: "heartbeat" }
  >;

/** Newest first, one sample per minute ending at `now`. */
function samples(now: number, oks: boolean[], degraded: boolean[] = []): RecentSample[] {
  return oks.map((ok, i) => ({
    ts: now - i * 60,
    ok: ok ? 1 : 0,
    degraded: degraded[i] ? 1 : 0,
  }));
}

describe("statusMatches", () => {
  it("matches a status class", () => {
    expect(statusMatches("2xx", 200)).toBe(true);
    expect(statusMatches("2xx", 204)).toBe(true);
    expect(statusMatches("2xx", 301)).toBe(false);
    expect(statusMatches("3xx", 302)).toBe(true);
  });

  it("matches an explicit list", () => {
    expect(statusMatches([200, 204], 204)).toBe(true);
    expect(statusMatches([200, 204], 201)).toBe(false);
  });
});

describe("runHttpCheck", () => {
  const respond = (init: ResponseInit, body: string | null = null) => async () => new Response(body, init);

  it("passes on an expected status", async () => {
    const s = await runHttpCheck(http(), respond({ status: 204 }));
    expect(s).toMatchObject({ ok: true, degraded: false, status: 204, error: null });
  });

  it("fails on an unexpected status", async () => {
    const s = await runHttpCheck(http(), respond({ status: 503 }));
    expect(s.ok).toBe(false);
    expect(s.error).toBe("unexpected status 503");
  });

  it("fails when the body does not contain the expected substring", async () => {
    const m = http('    expect_body: \'"status":"ok"\'\n');
    const s = await runHttpCheck(m, respond({ status: 200 }, '{"status":"degraded"}'));
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/body did not contain/);
  });

  it("passes when the body matches", async () => {
    const m = http('    expect_body: \'"status":"ok"\'\n');
    const s = await runHttpCheck(m, respond({ status: 200 }, '{"status":"ok"}'));
    expect(s.ok).toBe(true);
  });

  it("turns a network error into a failed sample rather than throwing", async () => {
    const s = await runHttpCheck(http(), async () => {
      throw new TypeError("connection refused");
    });
    expect(s.ok).toBe(false);
    expect(s.error).toBe("TypeError: connection refused");
    expect(s.status).toBeNull();
  });

  it("reports a timeout as such", async () => {
    const s = await runHttpCheck(http("    timeout: 1s\n"), async (_u, init) => {
      await new Promise((_r, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
        );
      });
      return new Response();
    });
    expect(s.ok).toBe(false);
    expect(s.error).toBe("timed out after 1s");
  });

  it("marks a slow but successful response as degraded", async () => {
    const m = http("    degraded_ms: 1\n");
    const s = await runHttpCheck(m, async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Response("", { status: 200 });
    });
    expect(s.ok).toBe(true);
    expect(s.degraded).toBe(true);
  });
});

describe("checkHeartbeat", () => {
  const now = 1_800_000_000;

  it("has no data before the first ping", () => {
    expect(checkHeartbeat(heartbeat(), null, now)).toBeNull();
  });

  it("passes inside period + grace", () => {
    const m = heartbeat("    grace: 10m\n");
    expect(checkHeartbeat(m, now - 3600 - 300, now)?.ok).toBe(true);
  });

  it("fails once period + grace has passed", () => {
    const m = heartbeat("    grace: 10m\n");
    const s = checkHeartbeat(m, now - 3600 - 700, now)!;
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/no ping for/);
  });

  // A 24h/2h monitor 31 hours late used to say "no ping for 1d (expected every
  // 1d)": both numbers rounded to the same string, and it named the period
  // rather than the deadline that actually tripped. That reads like the page
  // wants more frequent pings than it does.
  it("names the elapsed time and the deadline, distinguishably", () => {
    const m = monitor("  - name: Job\n    type: heartbeat\n    period: 24h\n    grace: 2h\n") as Extract<
      Monitor,
      { type: "heartbeat" }
    >;
    const s = checkHeartbeat(m, now - 31 * 3600, now)!;
    expect(s.error).toBe("no ping for 1d 7h, expected within 1d 2h");
  });
});

describe("evaluate", () => {
  const now = 1_800_000_000;

  it("is unknown with no samples", () => {
    expect(evaluate(http(), [], now)).toBe("unknown");
  });

  it("is up when the latest sample passed", () => {
    expect(evaluate(http(), samples(now, [true, true, false]), now)).toBe("up");
  });

  it("is degraded when the latest sample was slow", () => {
    expect(evaluate(http(), samples(now, [true, true], [true, false]), now)).toBe("degraded");
  });

  it("does not alarm before the failure threshold", () => {
    const m = http("    failures_before_alarm: 3\n");
    expect(evaluate(m, samples(now, [false, false, true]), now)).toBe("degraded");
  });

  it("alarms at the failure threshold", () => {
    const m = http("    failures_before_alarm: 3\n");
    expect(evaluate(m, samples(now, [false, false, false, true]), now)).toBe("down");
  });

  it("alarms once the failure streak has lasted failing_for", () => {
    const m = http("    failing_for: 5m\n");
    // Four minutes of failures — not long enough yet.
    expect(evaluate(m, samples(now, [false, false, false, false, true]), now)).toBe("degraded");
    // Six minutes of failures.
    expect(evaluate(m, samples(now, [false, false, false, false, false, false, true]), now)).toBe("down");
  });

  it("does not let a stale streak count once a check has passed", () => {
    const m = http("    failing_for: 5m\n");
    const s = samples(now, [true, false, false, false, false, false, false]);
    expect(evaluate(m, s, now)).toBe("up");
  });

  it("alarms on whichever rule trips first when both are set", () => {
    const m = http("    failing_for: 1h\n    failures_before_alarm: 2\n");
    expect(evaluate(m, samples(now, [false, false, true]), now)).toBe("down");
  });
});

describe("formatDuration", () => {
  it("picks a sensible unit", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(300)).toBe("5m");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(172800)).toBe("2d");
  });

  // Past a day, rounding to whole days collapses every deadline in a 24-hour
  // span onto the same string, which is exactly where heartbeat messages live.
  it("keeps the hours once past a day", () => {
    expect(formatDuration(93600)).toBe("1d 2h");
    expect(formatDuration(111600)).toBe("1d 7h");
    expect(formatDuration(180000)).toBe("2d 2h");
  });

  it("never reports 24 hours instead of a day", () => {
    expect(formatDuration(86400 + 86340)).toBe("1d 23h");
  });
});

describe("day keys", () => {
  it("uses UTC", () => {
    expect(dayKey(Date.UTC(2026, 7, 7, 23, 59) / 1000)).toBe("2026-08-07");
  });

  it("returns the window oldest first", () => {
    const days = dayRange(Date.UTC(2026, 7, 7) / 1000, 3);
    expect(days).toEqual(["2026-08-05", "2026-08-06", "2026-08-07"]);
  });
});
