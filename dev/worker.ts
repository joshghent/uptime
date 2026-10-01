// The Worker `wrangler dev` runs in this repository, built the same way a
// deployment builds its own: the package's `createWorker` around the
// template's status.yaml.
import { createWorker } from "../src/index.ts";
import source from "../template/status.yaml";

export default createWorker(source);
