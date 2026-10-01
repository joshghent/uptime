// Creates `.dev.vars` from the template's example if it isn't there yet, so
// `${VAR}` in template/status.yaml resolves for `wrangler dev` and the linter.
// Left alone once it exists. Runs first from `dev`, `test` and `lint:config`.
import { copyFileSync, existsSync } from "node:fs";

const [from, to] = ["template/.dev.vars.example", ".dev.vars"];

if (!existsSync(to)) {
  copyFileSync(from, to);
  console.log(`created ${to} from ${from}`);
}
