#!/usr/bin/env node
// The `uptime` command, shipped in the package so it updates with it. A
// deployment's own repository only calls it; the logic lives here.
//
//   uptime lint [status.yaml]    validate the config the way the Worker does
//   uptime check                 lint, build, then boot the Worker and load it
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, type Config } from "./config.ts";

const CONFIG = "status.yaml";
const local = createRequire(import.meta.url);

// Read at run time rather than imported: this file runs straight from src/
// under Node as well as from dist/, and both sit one level below the
// package's own package.json.
const VERSION: string = local("../package.json").version;

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    fail(`cannot read ${path}`);
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * The same `.dev.vars` wrangler reads, so `${VAR}` resolves locally without
 * exporting anything. A real environment variable still wins.
 */
function devVars(): Record<string, string> {
  if (!existsSync(".dev.vars")) return {};
  const out: Record<string, string> = {};
  for (const line of read(".dev.vars").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Every `${VAR}` the file names, set or not. */
function referencedVars(source: string): string[] {
  return [...new Set([...source.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!))];
}

/** Validates and prints the monitors, or prints every problem and exits. */
function validate(path: string, source: string, env: Record<string, string | undefined>): Config {
  try {
    const config = loadConfig(source, env);
    console.log(`${path} is valid — ${config.monitors.length} monitors, "${config.title}"`);
    for (const m of config.monitors) {
      const how =
        m.type === "http"
          ? `${m.method} ${m.url}`
          : `heartbeat every ${m.period}s (+${m.grace}s grace) at /ping/${m.id}`;
      const alarm = [
        m.failuresBeforeAlarm !== undefined ? `${m.failuresBeforeAlarm} consecutive failures` : null,
        m.failingFor !== undefined ? `failing for ${m.failingFor}s` : null,
      ]
        .filter(Boolean)
        .join(" or ");
      console.log(`  ${m.id.padEnd(24)} every ${m.interval}s  ${how}`);
      console.log(`  ${" ".repeat(24)} alarm on ${alarm}`);
    }
    return config;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`${path} is invalid:`);
    for (const p of e.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}

function lint(path = CONFIG) {
  validate(path, read(path), { ...devVars(), ...process.env });
}

/** wrangler ships as a dependency of this package, so resolve it from here. */
function wrangler(args: string[], opts: { quiet?: boolean } = {}) {
  const pkg = local.resolve("wrangler/package.json");
  const bin = join(pkg, "..", "bin", "wrangler.js");
  return spawn(process.execPath, [bin, ...args], { stdio: opts.quiet ? "pipe" : "inherit" });
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    wrangler(args)
      .on("error", reject)
      .on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`wrangler ${args[0]} exited ${code}`))));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function get(url: string): Promise<Response | undefined> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch {
    return undefined; // not listening yet
  }
}

/**
 * Proves an update works with this config before it merges: the same
 * validation the Worker runs, the same build a deploy runs, then the Worker
 * itself booted locally against an empty database — which also exercises the
 * migrations — and its page and /health loaded.
 *
 * Secrets are not needed to prove any of that, and CI does not have them, so
 * an unset `${VAR}` is filled with a placeholder rather than failing.
 */
async function check() {
  const source = read(CONFIG);
  const env: Record<string, string | undefined> = { ...devVars(), ...process.env };
  const placeholders = referencedVars(source).filter((n) => typeof env[n] !== "string");
  for (const n of placeholders) env[n] = `https://placeholder.invalid/${n}`;
  if (placeholders.length) console.log(`using placeholders for unset ${placeholders.join(", ")}`);
  validate(CONFIG, source, env);

  const scratch = mkdtempSync(join(tmpdir(), "uptime-check-"));
  try {
    console.log("\nbuilding…");
    await run(["deploy", "--dry-run", "--outdir", join(scratch, "build")]);

    const vars = referencedVars(source).map((n) => `${n}=${JSON.stringify(env[n])}`);
    writeFileSync(join(scratch, "vars.env"), vars.join("\n"));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    console.log(`\nbooting on ${base}…`);
    const dev = wrangler(
      [
        "dev", "--local", "--ip", "127.0.0.1", "--port", String(port),
        "--persist-to", join(scratch, "state"), "--env-file", join(scratch, "vars.env"),
        "--show-interactive-dev-session=false",
      ],
      { quiet: true },
    );
    let output = "";
    dev.stdout?.on("data", (d) => (output += d));
    dev.stderr?.on("data", (d) => (output += d));

    try {
      let health: Response | undefined;
      for (let i = 0; i < 60 && !health; i++) {
        health = await get(`${base}/health`);
        if (!health) await new Promise((r) => setTimeout(r, 1000));
      }
      if (!health) throw new Error(`the Worker did not start:\n${output}`);
      const body = await health.text();
      if (health.status !== 200) throw new Error(`/health answered ${health.status}: ${body}\n${output}`);
      console.log(`  /health  ${body}`);

      const page = await get(`${base}/`);
      if (page?.status !== 200) throw new Error(`/ answered ${page?.status}:\n${await page?.text()}\n${output}`);
      console.log(`  /        200`);
    } finally {
      dev.kill();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`\nuptime ${VERSION} works with this ${CONFIG}`);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "lint":
    lint(args[0]);
    break;
  case "check":
    await check().catch((e: Error) => fail(e.message));
    break;
  default:
    fail(`usage: uptime <lint [file] | check>`);
}
