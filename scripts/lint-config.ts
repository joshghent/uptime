// Validates status.yaml the same way the Worker does, so a bad config fails
// on your laptop instead of in production.
//
//   pnpm lint:config [path/to/status.yaml]
import { readFileSync } from "node:fs";
import { ConfigError, loadConfig } from "../src/config.ts";

const path = process.argv[2] ?? "status.yaml";

function read(): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    console.error(`cannot read ${path}`);
    process.exit(1);
  }
}

try {
  const config = loadConfig(read(), process.env);
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
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`${path} is invalid:`);
    for (const p of e.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  throw e;
}
