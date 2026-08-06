import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.ts";
import * as db from "../src/db.ts";
import { runChecks } from "../src/run.ts";
import { buildStatus } from "../src/status.ts";

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

  it("prunes samples past the retention window", async () => {
    const c = site();
    await runChecks(env.DB, c, NOW, fakeFetch([]).impl);
    await runChecks(env.DB, c, NOW + 8 * 86400, fakeFetch([]).impl);

    const { results } = await env.DB.prepare("SELECT ts FROM samples").all<{ ts: number }>();
    expect(results.map((r) => r.ts)).toEqual([NOW + 8 * 86400]);
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
