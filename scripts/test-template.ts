// Tests the package the way a deployment uses it: packs it as npm would
// publish it, starts a deployment from the template with `uptime init`,
// installs the tarball with npm, and runs that deployment's own check.
//
//   pnpm test:template
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "uptime-template-"));

// Without the secrets CI sets for this repository's own lint, as a new
// deployment's CI would be.
const { NTFY_URL: _ntfy, HEARTBEAT_TOKEN: _heartbeat, ...env } = process.env;
const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: "inherit", env });

try {
  sh("pnpm", ["pack", "--pack-destination", scratch], ".");
  const tarball = join(scratch, readdirSync(scratch).find((f) => f.endsWith(".tgz"))!);

  const site = join(scratch, "site");
  sh("node", [resolve("dist/cli.js"), "init", site], ".");
  sh("npm", ["install", "--no-audit", "--no-fund", tarball], site);

  // Workers Builds deploys with `npx wrangler deploy`, so the wrangler this
  // package depends on has to be the one npx finds.
  sh("npx", ["--no-install", "wrangler", "--version"], site);
  sh("npm", ["run", "check"], site);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
