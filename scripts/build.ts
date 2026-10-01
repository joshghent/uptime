// Builds what gets published to npm: the Worker as one ES module with its
// dependencies, CSS, llms.txt and migrations inlined, plus its types.
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

copyFileSync("types/index.d.ts", "dist/index.d.ts");
console.log("built dist/");
