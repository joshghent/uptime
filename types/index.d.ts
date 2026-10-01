// Written by hand rather than emitted: the public surface is one function,
// and emitting would drag this repository's generated Worker types along.
// D1Database and ExportedHandler come from @cloudflare/workers-types or
// `wrangler types`, whichever the deployment uses.

/** The bindings the Worker reads. `${VAR}` in status.yaml can name any other. */
export interface Env {
  DB: D1Database;
  [secret: string]: unknown;
}

/**
 * The whole status page, built around the text of one status.yaml:
 *
 *   import { createWorker } from "@joshghent/uptime";
 *   import config from "./status.yaml";
 *   export default createWorker(config);
 */
export declare function createWorker(source: string): ExportedHandler<Env>;
