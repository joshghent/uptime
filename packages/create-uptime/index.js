#!/usr/bin/env node
// `npm create uptime [dir]` is `uptime init [dir]`. The template and the code
// that copies it live in @joshghent/uptime, which this release pins exactly.
process.argv.splice(2, 0, "init");
await import("@joshghent/uptime/cli");
