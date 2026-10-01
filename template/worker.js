// The whole Worker. Everything else comes from @joshghent/uptime, which
// updates arrive through — this file and status.yaml are the parts you own.
import { createWorker } from "@joshghent/uptime";
import config from "./status.yaml";

export default createWorker(config);
