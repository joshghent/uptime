// The Worker `wrangler dev` runs in this repository, built the same way a
// deployment builds its own: the package's `createWorker` around a status.yaml.
import { createWorker } from "../src/index.ts";
import source from "../status.yaml";

export default createWorker(source);
