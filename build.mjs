import * as esbuild from "esbuild";
import { cp, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");

// Each extension context is its own entry point and gets its own bundle.
// Later commits add entries here: offscreen document, embedder worker.
const options = {
  entryPoints: {
    "service-worker": "src/background/service-worker.ts",
    popup: "src/popup/popup.ts",
    offscreen: "src/offscreen/offscreen.ts",
    "embedder-worker": "src/workers/embedder.worker.ts",
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
  // ONNX Runtime's WASM backend is CODE and must ship inside the package
  // (MV3 remote-code ban). ORT loads the .mjs/.wasm pair at runtime from
  // env.backends.onnx.wasm.wasmPaths, which the worker points at dist/.
  const ortDist = "node_modules/onnxruntime-web/dist";
  for (const file of [
    // Plain build: the pure-WASM (CPU) fallback path.
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
    // JSEP build: the WebGPU-capable runtime (also does CPU).
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
  ]) {
    await cp(`${ortDist}/${file}`, `dist/${file}`);
  }
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
