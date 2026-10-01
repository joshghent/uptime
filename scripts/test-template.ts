// Tests the packages the way a deployment uses them: packs both as npm would
// publish them, starts a deployment with create-uptime (what `npm create
// uptime` runs), installs the package with npm, and runs that deployment's
// own check.
//
//   pnpm test:template
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "uptime-template-"));

// Without the secrets CI sets for this repository's own lint, as a new
// deployment's CI would be.
const { NTFY_URL: _ntfy, HEARTBEAT_TOKEN: _heartbeat, ...env } = process.env;
const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: "inherit", env });

try {
  sh("pnpm", ["pack", "--pack-destination", scratch], ".");
  sh("npm", ["pack", "--pack-destination", scratch], "packages/create-uptime");
  const tgz = (prefix: string) => join(scratch, readdirSync(scratch).find((f) => f.startsWith(prefix))!);
  const [tarball, creator] = [tgz("joshghent-uptime-"), tgz("create-uptime-")];

  // Installing both tarballs together satisfies create-uptime's pin on the
  // package without the registry, which does not have this version yet.
  const tools = join(scratch, "tools");
  mkdirSync(tools);
  sh("npm", ["install", "--no-audit", "--no-fund", "--prefix", tools, tarball, creator], ".");
  const site = join(scratch, "site");
  sh(join(tools, "node_modules", ".bin", "create-uptime"), [site], ".");
  sh("npm", ["install", "--no-audit", "--no-fund", tarball], site);

  // Workers Builds deploys with `npx wrangler deploy`, so the wrangler this
  // package depends on has to be the one npx finds.
  sh("npx", ["--no-install", "wrangler", "--version"], site);
  sh("npm", ["run", "check"], site);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
