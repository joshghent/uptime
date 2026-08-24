import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import worker from "../src/index.ts";
import { REPO } from "../src/page.ts";
import { LATEST_MIGRATION, VERSION } from "../src/version.ts";
import source from "../status.yaml";

// Asserted against your own status.yaml, so editing it cannot silently break
// the page without a test noticing — on a fork as much as here.
const config = loadConfig(source, env as unknown as Record<string, unknown>);
const heartbeat = config.monitors.find((m) => m.type === "heartbeat");
const http = config.monitors.find((m) => m.type === "http")!;
if (!heartbeat || heartbeat.type !== "heartbeat") throw new Error("status.yaml needs a heartbeat monitor");

const get = async (path: string, init?: RequestInit) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://status.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

beforeEach(async () => {
  await env.DB.exec("DELETE FROM samples");
  await env.DB.exec("DELETE FROM daily");
  await env.DB.exec("DELETE FROM incidents");
  await env.DB.exec("DELETE FROM heartbeats");
});

describe("GET /", () => {
  it("renders every monitor from status.yaml", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);

    const html = await res.text();
    expect(html).toContain(config.title);
    for (const m of config.monitors) expect(html).toContain(m.name);
    // 90 day bars per monitor, all grey before any check has run.
    expect(html.match(/class="bar--none"/g)).toHaveLength(config.monitors.length * 90);
    expect(html).toContain("Waiting for the first check");
  });

  it("points at the source repo so a visitor can run their own", async () => {
    const html = await get("/").then((r) => r.text());
    expect(html).toContain("Run your own");
    expect(html).toContain(REPO);
  });

  it("shows the version it is running, so a bug report can name it", async () => {
    expect(await get("/").then((r) => r.text())).toContain(`v${VERSION}`);
  });

  it("shows an incident banner while a monitor is down", async () => {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare("INSERT INTO incidents (monitor, started_at, reason) VALUES (?, ?, ?)")
      .bind(http.id, now - 600, "unexpected status 503")
      .run();

    const html = await get("/").then((r) => r.text());
    expect(html).toContain("Some systems are down");
    expect(html).toContain("unexpected status 503");
    expect(html).toContain('class="status status--down"');
  });

  it("escapes values that come from the config and the database", async () => {
    await env.DB.prepare("INSERT INTO incidents (monitor, started_at, reason) VALUES (?, ?, ?)")
      .bind(http.id, 1, "<script>alert(1)</script>")
      .run();
    const html = await get("/").then((r) => r.text());
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("event history", () => {
  const badDay = (monitor: string, daysAgo: number, fail = 1, degraded = 0) => {
    const day = new Date((Date.now() - daysAgo * 86400_000)).toISOString().slice(0, 10);
    return env.DB.prepare("INSERT INTO daily (monitor, day, ok, fail, degraded) VALUES (?, ?, 100, ?, ?)")
      .bind(monitor, day, fail, degraded)
      .run();
  };

  // The bug this section exists for: a day can be red or amber without an
  // incident behind it, and the page used to show the colour and nothing else.
  it("lists a bad day that never opened an incident", async () => {
    await badDay(http.id, 1, 3);
    const html = await get("/").then((r) => r.text());
    expect(html).toContain("Event history");
    expect(html).toContain("3 checks of 103 failed");
  });

  it("lists a slow day, which never opens an incident at all", async () => {
    await badDay(http.id, 1, 0, 7);
    expect(await get("/").then((r) => r.text())).toContain("Slow responses");
  });

  it("shows five events and puts the rest behind an expander", async () => {
    for (let d = 1; d <= 8; d++) await badDay(http.id, d);
    const html = await get("/").then((r) => r.text());

    expect(html.match(/class="event event--/g)).toHaveLength(8);
    // Five in the open list, the other three inside the details.
    const [open] = html.split("<details");
    expect(open!.match(/class="event event--/g)).toHaveLength(5);
    expect(html).toContain("Show 3 older events");
  });

  it("filters the history to one service", async () => {
    const other = config.monitors.find((m) => m.id !== http.id)!;
    await badDay(http.id, 1);
    await badDay(other.id, 2);

    const html = await get(`/?monitor=${other.id}`).then((r) => r.text());
    expect(html.match(/class="event event--/g)).toHaveLength(1);
    expect(html).toContain(`<option value="${other.id}" selected>`);
    // The cards are never filtered — the page still reports every service.
    for (const m of config.monitors) expect(html).toContain(m.name);
  });

  it("says so when the filtered service has no events", async () => {
    await badDay(http.id, 1);
    const other = config.monitors.find((m) => m.id !== http.id)!;
    const html = await get(`/?monitor=${other.id}`).then((r) => r.text());
    expect(html).toContain(`No events for ${other.name} in the last 90 days.`);
  });

  it("ignores an unknown monitor rather than showing an empty page", async () => {
    await badDay(http.id, 1);
    const html = await get("/?monitor=nope").then((r) => r.text());
    expect(html.match(/class="event event--/g)).toHaveLength(1);
  });

  it("has nothing to show on a clean window", async () => {
    expect(await get("/").then((r) => r.text())).toContain("No events in the last 90 days.");
  });
});

describe("uptime figure", () => {
  it("is labelled with the days it was measured over, not the window length", async () => {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO daily (monitor, day, ok, fail, degraded) VALUES (?, ?, 999, 1, 0)")
      .bind(http.id, day)
      .run();

    const html = await get("/").then((r) => r.text());
    // One day of data in a 90-day window: 99.90% over 1 day.
    expect(html).toContain("99.90% over 1 day");
    expect(html).not.toContain("99.90% uptime over the last 90 days");
  });
});

describe("GET /llms.txt", () => {
  it("serves the reference as plain text, CORS-open", async () => {
    const res = await get("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const text = await res.text();
    // The reference is only useful to an agent if it covers both halves: how to
    // read a running page, and how to configure one.
    expect(text).toContain("/api/status");
    expect(text).toContain("expect_body");
    expect(text).toContain("period");
  });

  it("is linked from the page, so an agent can find it without guessing", async () => {
    expect(await get("/").then((r) => r.text())).toContain('href="/llms.txt"');
  });
});

describe("GET /api/status", () => {
  it("returns the same data as JSON", async () => {
    const res = await get("/api/status");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const body = (await res.json()) as {
      monitors: unknown[];
      overall: string;
      windowDays: number;
      events: unknown[];
    };
    expect(body.windowDays).toBe(90);
    expect(body.overall).toBe("unknown");
    expect(body.monitors).toHaveLength(config.monitors.length);
    expect(body.monitors[0]).toMatchObject({ id: http.id, name: http.name, uptime: null, observedDays: 0 });
    expect(body.events).toEqual([]);
  });
});

describe("GET /ping/:id", () => {
  const token = heartbeat.token!;
  const lastPing = () =>
    env.DB.prepare("SELECT last_ping FROM heartbeats WHERE monitor = ?").bind(heartbeat.id).first();

  it("records a ping when the token matches", async () => {
    expect((await get(`/ping/${heartbeat.id}?token=${token}`)).status).toBe(200);
    expect(await lastPing()).not.toBeNull();
  });

  it("accepts the token as a bearer header", async () => {
    const res = await get(`/ping/${heartbeat.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });

  it("rejects a missing or wrong token", async () => {
    expect((await get(`/ping/${heartbeat.id}`)).status).toBe(401);
    expect((await get(`/ping/${heartbeat.id}?token=nope`)).status).toBe(401);
    expect(await lastPing()).toBeNull();
  });

  it("404s for an unknown id and for an HTTP monitor", async () => {
    expect((await get("/ping/nope")).status).toBe(404);
    expect((await get(`/ping/${http.id}`)).status).toBe(404);
  });
});

describe("scheduled", () => {
  it("checks monitors and writes samples", async () => {
    // Without this the checks reach the real network, which miniflare blocks
    // with an opaque error rather than a useful failure.
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      seen.push(String(input));
      return new Response('{"status":"ok"}', { status: 200 });
    });

    const ctx = createExecutionContext();
    await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.now() } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);

    // Heartbeats that have never been pinged record nothing, so only the HTTP
    // monitors show up.
    const httpIds = config.monitors.filter((m) => m.type === "http").map((m) => m.id).sort();
    const { results } = await env.DB.prepare("SELECT DISTINCT monitor FROM samples").all<{ monitor: string }>();
    expect(results.map((r) => r.monitor).sort()).toEqual(httpIds);
    expect(seen).toHaveLength(httpIds.length);
  });

  afterEach(() => vi.unstubAllGlobals());
});

describe("GET /health", () => {
  it("reports ok, the version, and the schema it expects", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      version: VERSION,
      latestMigration: LATEST_MIGRATION,
      migrationsApplied: true,
    });
  });

  // The point of the endpoint: a deploy whose migration was never applied is
  // otherwise invisible until something reads a column that isn't there.
  // Pointing a monitor at your own /health turns it into a normal incident.
  it("answers 503 when the newest migration has not been applied", async () => {
    await env.DB.exec(`DELETE FROM d1_migrations WHERE name = '${LATEST_MIGRATION}'`);

    const res = await get("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "degraded", migrationsApplied: false });
  });
});
