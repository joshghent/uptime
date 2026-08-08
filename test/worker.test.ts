import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import worker from "../src/index.ts";
import source from "../status.yaml";

// Asserted against the real shipped config, so editing status.yaml cannot
// silently break the page without a test noticing.
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
    expect(html).toContain("https://github.com/joshghent/uptime");
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

    const body = (await res.json()) as { monitors: unknown[]; overall: string; windowDays: number };
    expect(body.windowDays).toBe(90);
    expect(body.overall).toBe("unknown");
    expect(body.monitors).toHaveLength(config.monitors.length);
    expect(body.monitors[0]).toMatchObject({ id: http.id, name: http.name, uptime: null });
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
  it("answers without touching the database", async () => {
    expect(await get("/health").then((r) => r.text())).toBe("ok\n");
  });
});
