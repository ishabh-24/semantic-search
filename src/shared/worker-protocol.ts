// Protocol between the offscreen document and the embedder Web Worker
// (structured clone + transferables — no Chrome APIs on this boundary).
// Chrome-free so both the DOM and WebWorker tsconfigs can import it.

export type WorkerRequest = { id: number; type: "embed"; texts: string[] };

export type WorkerResponse =
  | {
      id: number;
      ok: true;
      dims: number;
      /** Row-major [texts.length × dims], transferred, not copied. */
      vectors: Float32Array;
      /** Identifies the worker instance — proves warmth across SW restarts. */
      workerStartedAt: number;
      embedsServed: number;
      /** Active inference backend ("webgpu" or "wasm"). */
      backend: string;
      /** Wall time of the last pipeline load; 0 until the model is ready. */
      modelLoadMs: number;
      /** Compute time of this embed call only (excludes messaging). */
      inferMs: number;
    }
  | { id: number; ok: false; error: string };
