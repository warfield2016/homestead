// Builds two bundles:
//   dist/server.mjs  - the Node server (dependencies stay in node_modules)
//   dist/web/*       - the browser UI. The onboarding code (viem accounts, used to sign with a
//                      recovery phrase) is split into its own chunk and only loads on that screen.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/web", { recursive: true });

await build({
  entryPoints: ["src/server/main.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  packages: "external",
  sourcemap: true,
  logLevel: "warning",
});

await build({
  entryPoints: ["src/web/main.ts"],
  outdir: "dist/web",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  minify: true,
  sourcemap: true,
  entryNames: "[name]",
  chunkNames: "chunk-[hash]",
  logLevel: "warning",
});

cpSync("src/web/style.css", "dist/web/style.css");
// Stamp a content hash onto the entry URLs so browsers pick up a new UI right after an upgrade.
const version = (file) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 10);
const html = readFileSync("src/web/index.html", "utf8")
  .replace('"/main.js"', `"/main.js?v=${version("dist/web/main.js")}"`)
  .replace('"/style.css"', `"/style.css?v=${version("dist/web/style.css")}"`);
writeFileSync("dist/web/index.html", html);
cpSync("src/web/icon.svg", "dist/web/icon.svg");
console.log("built dist/server.mjs and dist/web/");
