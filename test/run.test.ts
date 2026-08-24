import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.ts";
import * as db from "../src/db.ts";
import { dayKey } from "../src/check.ts";
import { runChecks } from "../src/run.ts";
import { buildStatus, dayStart, EVENT_LIMIT } from "../src/status.ts";

const NOW = 1_800_000_000;

const config = (yaml: string): Config =>
  loadConfig(`
notify:
  ntfy: https://ntfy.test/topic
  webhook: https://hooks.test/incoming
monitors:
${yaml}`);

const site = (extra = "") => config(`  - name: Site\n    url: https://site.test/health\n${extra}`);

/** Records every outbound call and replies with whatever is queued. */
function fakeFetch(replies: (Response | Error)[]) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    calls.push({
      url,
      body: String(init?.body ?? ""),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response(null, { status: 200 });
  };
  return { impl, calls };
}

type Call = { url: string; body: string; headers: Record<string, string> };

/** Everything that is not a health check is a notification. */
const notifications = (calls: Call[]) => calls.filter((c) => !c.url.startsWith("https://site.test"));

beforeEach(async () => {
  await env.DB.exec("DELETE FROM samples");
  await env.DB.exec("DELETE FROM daily");
  await env.DB.exec("DELETE FROM incidents");
  await env.DB.exec("DELETE FROM heartbeats");
});

describe("runChecks", () => {
  it("records a passing check without opening an incident", async () => {
    const { impl } = fakeFetch([new Response(null, { status: 200 })]);
    const results = await runChecks(env.DB, site(), NOW, impl);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ monitor: "site", state: "up" });
    expect(results[0]!.transition).toBeUndefined();
    expect(await db.openIncidents(env.DB)).toEqual(new Map());
  });

  it("opens an incident and notifies after the second consecutive failure", async () => {
    const c = site();
    const first = fakeFetch([new Response(null, { status: 500 })]);
    expect((await runChecks(env.DB, c, NOW, first.impl))[0]!.state).toBe("degraded");
    expect(notifications(first.calls)).toHaveLength(0);

    const second = fakeFetch([new Response(null, { status: 500 })]);
    const r = (await runChecks(env.DB, c, NOW + 60, second.impl))[0]!;
    expect(r.state).toBe("down");
    expect(r.transition).toBe("opened");

    const incident = (await db.openIncidents(env.DB)).get("site")!;
    expect(incident.started_at).toBe(NOW + 60);
    expect(incident.reason).toBe("unexpected status 500");

    const sent = notifications(second.calls);
    expect(sent.map((s) => s.url).sort()).toEqual(["https://hooks.test/incoming", "https://ntfy.test/topic"]);
    expect(sent.find((s) => s.url.includes("ntfy"))!.headers.Title).toBe("DOWN: Site");
    expect(JSON.parse(sent.find((s) => s.url.includes("hooks"))!.body)).toMatchObject({
      monitor: "site",
      event: "down",
      reason: "unexpected status 500",
    });
  });

  it("resolves the incident and notifies on recovery", async () => {
    const c = site();
    for (const t of [0, 60]) {
      await runChecks(env.DB, c, NOW + t, fakeFetch([new Response(null, { status: 500 })]).impl);
    }
    expect((await db.openIncidents(env.DB)).has("site")).toBe(true);

    const recovery = fakeFetch([new Response(null, { status: 200 })]);
    const r = (await runChecks(env.DB, c, NOW + 120, recovery.impl))[0]!;
    expect(r.transition).toBe("resolved");
    expect((await db.openIncidents(env.DB)).has("site")).toBe(false);

    const sent = notifications(recovery.calls);
    expect(sent.find((s) => s.url.includes("ntfy"))!.headers.Title).toBe("RECOVERED: Site");
  });

  it("does not re-open or re-notify while an incident is already open", async () => {
    const c = site();
    for (const t of [0, 60]) {
      await runChecks(env.DB, c, NOW + t, fakeFetch([new Response(null, { status: 500 })]).impl);
    }
    const third = fakeFetch([new Response(null, { status: 500 })]);
    const r = (await runChecks(env.DB, c, NOW + 120, third.impl))[0]!;
    expect(r.transition).toBeUndefined();
    expect(notifications(third.calls)).toHaveLength(0);

    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM incidents").all<{ n: number }>();
    expect(results[0]!.n).toBe(1);
  });

  it("keeps recording the check when a notification target is down", async () => {
    const c = site();
    await runChecks(env.DB, c, NOW, fakeFetch([new Response(null, { status: 500 })]).impl);
    const broken = fakeFetch([
      new Response(null, { status: 500 }),
      new Error("ntfy unreachable"),
      new Error("webhook unreachable"),
    ]);
    const r = (await runChecks(env.DB, c, NOW + 60, broken.impl))[0]!;
    expect(r.transition).toBe("opened");
    expect((await db.openIncidents(env.DB)).has("site")).toBe(true);
  });

  it("skips a monitor whose interval has not elapsed", async () => {
    const c = site("    interval: 5m\n");
    expect(await runChecks(env.DB, c, NOW, fakeFetch([]).impl)).toHaveLength(1);
    expect(await runChecks(env.DB, c, NOW + 60, fakeFetch([]).impl)).toHaveLength(0);
    expect(await runChecks(env.DB, c, NOW + 300, fakeFetch([]).impl)).toHaveLength(1);
  });

  it("rolls results into the daily bucket", async () => {
    const c = site();
    await runChecks(env.DB, c, NOW, fakeFetch([new Response(null, { status: 200 })]).impl);
    await runChecks(env.DB, c, NOW + 60, fakeFetch([new Response(null, { status: 500 })]).impl);

    const rows = await db.dailySince(env.DB, "1970-01-01");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ monitor: "site", ok: 1, fail: 1, degraded: 0 });
  });

  // NOW is deliberately on an hour boundary — retention only runs on the tick
  // where `Math.floor(now / 60) % 60 === 0`.
  it("is anchored on an hour boundary", () => {
    expect(NOW % 3600).toBe(0);
  });

  it("prunes samples past the retention window on the hourly tick", async () => {
    const c = site();
    await runChecks(env.DB, c, NOW, fakeFetch([]).impl);
    await runChecks(env.DB, c, NOW + 8 * 86400, fakeFetch([]).impl);

    const { results } = await env.DB.prepare("SELECT ts FROM samples").all<{ ts: number }>();
    expect(results.map((r) => r.ts)).toEqual([NOW + 8 * 86400]);
  });

  it("does not prune on the other 59 ticks of the hour", async () => {
    const c = site();
    await runChecks(env.DB, c, NOW, fakeFetch([]).impl);
    // 8 days later but one minute past the hour, so the old sample survives.
    await runChecks(env.DB, c, NOW + 8 * 86400 + 60, fakeFetch([]).impl);

    const { results } = await env.DB.prepare("SELECT ts FROM samples ORDER BY ts").all<{ ts: number }>();
    expect(results).toHaveLength(2);
  });

  it("carries on when one monitor throws and still checks the others", async () => {
    const c = config(`
  - name: Broken
    url: https://site.test/broken
  - name: Fine
    url: https://site.test/fine
`);
    const results = await runChecks(env.DB, c, NOW, async (input) => {
      if (String(input).includes("broken")) throw new Error("boom");
      return new Response(null, { status: 200 });
    });
    // The thrown error becomes a failed sample, not a lost monitor.
    expect(results.map((r) => r.monitor).sort()).toEqual(["broken", "fine"]);
  });
});

describe("heartbeat monitors", () => {
  const job = () =>
    config(`
  - name: Backup
    type: heartbeat
    period: 1h
    grace: 10m
`);

  it("records nothing until the first ping", async () => {
    expect(await runChecks(env.DB, job(), NOW, fakeFetch([]).impl)).toHaveLength(0);
  });

  it("passes while pings arrive on time", async () => {
    await db.recordPing(env.DB, "backup", NOW - 1800);
    const r = (await runChecks(env.DB, job(), NOW, fakeFetch([]).impl))[0]!;
    expect(r.state).toBe("up");
  });

  it("alarms once a ping is overdue", async () => {
    // period 1h + grace 10m = 4200s of slack.
    await db.recordPing(env.DB, "backup", NOW - 5000);
    const c = job();
    await runChecks(env.DB, c, NOW, fakeFetch([]).impl);
    const r = (await runChecks(env.DB, c, NOW + 60, fakeFetch([]).impl))[0]!;
    expect(r.state).toBe("down");
    expect(r.sample.error).toMatch(/no ping for/);
    expect((await db.openIncidents(env.DB)).has("backup")).toBe(true);
  });
});

describe("buildStatus", () => {
  it("reports no data before any check has run", async () => {
    const s = await buildStatus(env.DB, site(), NOW);
    expect(s.overall).toBe("unknown");
    expect(s.monitors[0]).toMatchObject({ uptime: null, state: "unknown", lastCheck: null });
    expect(s.monitors[0]!.days).toHaveLength(90);
    expect(new Set(s.monitors[0]!.days.map((d) => d.state))).toEqual(new Set(["none"]));
  });

  it("computes uptime and per-day state from the rollups", async () => {
    const c = site();
    // Yesterday: one pass. Today: one pass, one failure.
    await runChecks(env.DB, c, NOW - 86400, fakeFetch([new Response(null, { status: 200 })]).impl);
    await runChecks(env.DB, c, NOW, fakeFetch([new Response(null, { status: 200 })]).impl);
    await runChecks(env.DB, c, NOW + 60, fakeFetch([new Response(null, { status: 500 })]).impl);

    const s = await buildStatus(env.DB, c, NOW + 60);
    const m = s.monitors[0]!;
    expect(m.uptime).toBeCloseTo(2 / 3);
    expect(m.days.at(-1)!.state).toBe("down");
    expect(m.days.at(-2)!.state).toBe("up");
    expect(m.days.at(-3)!.state).toBe("none");
  });

  it("measures uptime over the days that have data, not the whole window", async () => {
    const c = site();
    await runChecks(env.DB, c, NOW - 86400, fakeFetch([new Response(null, { status: 200 })]).impl);
    await runChecks(env.DB, c, NOW, fakeFetch([new Response(null, { status: 200 })]).impl);

    const m = (await buildStatus(env.DB, c, NOW)).monitors[0]!;
    // Two days of data inside a 90-day window: 100%, not 2/90.
    expect(m.uptime).toBe(1);
    expect(m.observedDays).toBe(2);
    expect(m.days).toHaveLength(90);
  });

  it("takes the worst monitor as the overall state", async () => {
    const c = config(`
  - name: Good
    url: https://site.test/good
  - name: Bad
    url: https://site.test/bad
`);
    const reply: typeof fetch = async (input) =>
      new Response(null, { status: String(input).includes("bad") ? 500 : 200 });
    await runChecks(env.DB, c, NOW, reply);
    await runChecks(env.DB, c, NOW + 60, reply);

    const s = await buildStatus(env.DB, c, NOW + 60);
    expect(s.overall).toBe("down");
    expect(s.monitors.find((m) => m.id === "good")!.state).toBe("up");
    expect(s.monitors.find((m) => m.id === "bad")!.state).toBe("down");
    expect(s.incidents.map((i) => i.monitor)).toEqual(["bad"]);
  });
});

/**
 * A red or amber bar does not imply an incident: a single failed check colours
 * the day red without meeting `failures_before_alarm`, and a slow-but-passing
 * check colours it amber and never alarms at all. The history is built from the
 * same rollups the bars are, so every colour on the page has a row explaining it.
 */
describe("event history", () => {
  const events = async (c: Config, now = NOW) => (await buildStatus(env.DB, c, now)).events;

  /** Writes a rollup day directly — the shape a bar is drawn from. */
  const day = (monitor: string, day: string, ok: number, fail: number, degraded = 0) =>
    env.DB.prepare("INSERT INTO daily (monitor, day, ok, fail, degraded) VALUES (?, ?, ?, ?, ?)")
      .bind(monitor, day, ok, fail, degraded)
      .run();

  const today = dayKey(NOW);
  const yesterday = dayKey(NOW - 86400);

  it("explains a failed day that never opened an incident", async () => {
    await day("site", today, 1439, 1);

    expect(await events(site())).toEqual([
      {
        monitor: "site",
        name: "Site",
        kind: "outage",
        at: dayStart(today),
        until: null,
        day: today,
        reason: "1 check of 1440 failed",
      },
    ]);
  });

  it("explains a slow day, which never alarms at all", async () => {
    await day("site", today, 1440, 0, 12);

    const [e] = await events(site());
    expect(e).toMatchObject({ kind: "degraded", day: today });
    expect(e!.reason).toContain("12 checks of 1440");
  });

  it("says nothing about a clean day", async () => {
    await day("site", today, 1440, 0);
    expect(await events(site())).toEqual([]);
  });

  it("reports an incident once, not again as a bad day", async () => {
    const c = site();
    await day("site", yesterday, 1400, 40);
    await env.DB.prepare("INSERT INTO incidents (monitor, started_at, resolved_at, reason) VALUES (?, ?, ?, ?)")
      .bind("site", NOW - 86400, NOW - 80000, "unexpected status 503")
      .run();

    const list = await events(c);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "incident", reason: "unexpected status 503", until: NOW - 80000 });
  });

  it("keeps covering days for an incident that is still open", async () => {
    await day("site", yesterday, 1400, 40);
    await day("site", today, 700, 20);
    await env.DB.prepare("INSERT INTO incidents (monitor, started_at, reason) VALUES (?, ?, ?)")
      .bind("site", NOW - 86400, "down")
      .run();

    const list = await events(site());
    expect(list.map((e) => e.kind)).toEqual(["incident"]);
    expect(list[0]!.until).toBeNull();
  });

  it("orders newest first across monitors and carries the display name", async () => {
    const c = config(`
  - name: Good
    url: https://site.test/good
  - name: Bad
    url: https://site.test/bad
`);
    await day("good", yesterday, 100, 1);
    await day("bad", today, 100, 5);

    expect((await events(c)).map((e) => [e.name, e.day])).toEqual([
      ["Bad", today],
      ["Good", yesterday],
    ]);
  });

  it("caps each monitor's history so one noisy service cannot bury another", async () => {
    const c = config(`
  - name: Noisy
    url: https://site.test/noisy
  - name: Quiet
    url: https://site.test/quiet
`);
    for (let i = 0; i < EVENT_LIMIT + 10; i++) await day("noisy", dayKey(NOW - i * 86400), 100, 1);
    await day("quiet", dayKey(NOW - 80 * 86400), 100, 1);

    const list = await events(c);
    expect(list.filter((e) => e.monitor === "noisy")).toHaveLength(EVENT_LIMIT);
    // The quiet monitor's single old event survives the noise.
    expect(list.filter((e) => e.monitor === "quiet")).toHaveLength(1);
  });

  it("ignores days that fell out of the 90-day window", async () => {
    await day("site", dayKey(NOW - 120 * 86400), 100, 5);
    expect(await events(site())).toEqual([]);
  });
});
