import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// Injected by vitest.config.ts so the setup file can apply the schema.
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
