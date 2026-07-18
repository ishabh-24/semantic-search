import * as esbuild from "esbuild";
import { cp, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

// Each extension context is its own entry point and gets its own bundle.
// Later commits add entries here: offscreen document, embedder worker.
const options = {
  entryPoints: {
    "service-worker": "src/background/service-worker.ts",
    popup: "src/popup/popup.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

// Static files (manifest, HTML, icons) are copied verbatim; esbuild only
// handles TypeScript. Keeps the mapping from source to dist/ trivially auditable.
async function copyStatic() {
  await cp("public", "dist", { recursive: true });
}

await rm("dist", { recursive: true, force: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await copyStatic();
  await ctx.watch();
  console.log("watching src/ — reload the extension in chrome://extensions after changes");
} else {
  await esbuild.build(options);
  await copyStatic();
}
