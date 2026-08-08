import { Hono } from "hono";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import * as db from "./db.ts";
import { esc, renderPage } from "./page.ts";
import { runChecks } from "./run.ts";
import { buildStatus } from "./status.ts";
import source from "../status.yaml";
import llms from "../llms.txt";

export type Env = Cloudflare.Env;

// Parsed once per isolate. Bindings don't change under a running Worker, and
// the config is baked into the bundle, so there is nothing to invalidate.
let cached: Config | undefined;
function getConfig(env: Env): Config {
  // Cast because `${VAR}` in status.yaml can name any secret, and those are
  // not in the generated Env type.
  return (cached ??= loadConfig(source, env as unknown as Record<string, unknown>));
}

const now = () => Math.floor(Date.now() / 1000);

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const status = await buildStatus(c.env.DB, getConfig(c.env), now());
  return c.html(renderPage(status), 200, { "cache-control": "public, max-age=30" });
});

app.get("/api/status", async (c) => {
  const status = await buildStatus(c.env.DB, getConfig(c.env), now());
  return c.json(status, 200, { "cache-control": "public, max-age=30", "access-control-allow-origin": "*" });
});

/**
 * Heartbeat receiver. A job pings this on its own schedule; the cron turns a
 * missing ping into an incident.
 */
app.on(["GET", "POST"], "/ping/:id", async (c) => {
  const id = c.req.param("id");
  const monitor = getConfig(c.env).monitors.find((m) => m.id === id && m.type === "heartbeat");
  if (!monitor) return c.text("unknown heartbeat monitor\n", 404);

  if (monitor.type === "heartbeat" && monitor.token) {
    const given = c.req.query("token") ?? c.req.header("authorization")?.replace(/^Bearer /i, "");
    if (given !== monitor.token) return c.text("bad token\n", 401);
  }

  await db.recordPing(c.env.DB, id, now());
  return c.text("ok\n");
});

/**
 * The whole reference — endpoints, JSON shape, every config key — as one plain
 * text file an agent can fetch instead of scraping the page or the repo.
 */
app.get("/llms.txt", (c) =>
  c.text(llms, 200, { "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" }),
);

app.get("/health", (c) => c.text("ok\n"));

// One handler. A broken config is the failure people will actually hit, so it
// gets a readable page instead of a stack trace.
app.onError((err, c) => {
  console.error(err);
  if (err instanceof ConfigError) {
    const list = err.problems.map((p) => `<li><code>${esc(p)}</code></li>`).join("");
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Configuration error</title></head>
<body style="font:14px/1.6 system-ui;max-width:60rem;margin:4rem auto;padding:0 1rem">
<h1>status.yaml is invalid</h1>
<ul>${list}</ul>
<p>Fix it and redeploy. Run <code>pnpm lint:config</code> locally to catch this before pushing.</p>
</body></html>`,
      500,
    );
  }
  return c.text("internal error\n", 500);
});

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const results = await runChecks(env.DB, getConfig(env), now());
    for (const r of results) {
      if (r.transition) console.log(`${r.monitor}: incident ${r.transition} (${r.sample.error ?? "recovered"})`);
    }
  },
};
