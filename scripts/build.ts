// Builds what gets published to npm: the Worker as one ES module with its
// dependencies, CSS, llms.txt and migrations inlined, its types, and the
// `uptime` command.
//
// Bundling the dependencies means a deployment runs exactly the code the
// release was tested with, and has one package to update rather than four.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker"],
  target: "es2022",
  loader: { ".css": "text", ".txt": "text", ".sql": "text" },
});

// The `uptime` command, for Node. wrangler is not bundled: it is a dependency
// of the package and is run from wherever it was installed.
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // yaml's Node build is CommonJS and requires Node builtins, which an ES
  // module bundle can only do through a require it is given.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});

copyFileSync("types/index.d.ts", "dist/index.d.ts");
console.log("built dist/");
