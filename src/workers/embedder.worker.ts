import type { WorkerRequest, WorkerResponse } from "../shared/worker-protocol";

// Embedder worker scaffold. Commit 7 replaces stubEmbed with the real
// transformers.js MiniLM pipeline; the lifecycle and protocol stay as-is.
// workerStartedAt/embedsServed exist to make warmth observable: if the
// service worker dies and the next embed reports the same workerStartedAt,
// the keep-alive works.

const DIMS = 384;
const workerStartedAt = Date.now();
let embedsServed = 0;

console.log(`[embedder] worker started at ${new Date(workerStartedAt).toISOString()}`);

/** Deterministic pseudo-embedding: FNV-1a-seeded xorshift, L2-normalized.
 *  Same text → same unit vector, so downstream cosine math is testable
 *  before the real model lands. */
function stubEmbed(text: string, out: Float32Array): void {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) {
    seed = ((seed ^ text.charCodeAt(i)) * 16777619) >>> 0;
  }
  let state = seed || 1;
  let sumSquares = 0;
  for (let d = 0; d < DIMS; d++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const value = state / 0xffffffff - 0.5;
    out[d] = value;
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares) || 1;
  for (let d = 0; d < DIMS; d++) out[d]! /= norm;
}

self.addEventListener("message", (event) => {
  const request = (event as MessageEvent).data as WorkerRequest;
  if (request.type !== "embed") return;

  try {
    const vectors = new Float32Array(request.texts.length * DIMS);
    request.texts.forEach((text, row) => {
      stubEmbed(text, vectors.subarray(row * DIMS, (row + 1) * DIMS));
    });
    embedsServed++;
    const response: WorkerResponse = {
      id: request.id,
      ok: true,
      dims: DIMS,
      vectors,
      workerStartedAt,
      embedsServed,
    };
    postMessage(response, [vectors.buffer]);
  } catch (error) {
    const response: WorkerResponse = { id: request.id, ok: false, error: String(error) };
    postMessage(response);
  }
});
