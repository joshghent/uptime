// Creates the files that are yours rather than upstream's, if they aren't
// there yet: `status.yaml` and `.dev.vars`. Both start as copies of the
// tracked `*.example` files, and both are left alone once they exist.
//
// Upstream does not track `status.yaml`, which is what makes updates painless
// — a merge from upstream can never conflict with your monitors. The flip side
// is that a fresh clone has no config at all, and `import "../status.yaml"`
// would fail with a module-resolution error rather than saying so. This runs
// first from `dev`, `test`, `lint:config` and `deploy`.
import { copyFileSync, existsSync } from "node:fs";

const pairs = [
  ["status.example.yaml", "status.yaml"],
  [".dev.vars.example", ".dev.vars"],
] as const;

for (const [from, to] of pairs) {
  if (existsSync(to) || !existsSync(from)) continue;
  copyFileSync(from, to);
  console.log(`created ${to} from ${from} — edit it, it is yours`);
}
