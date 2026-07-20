import { callWorker } from "./offscreen-client";
import {
  planBatches,
  DEFAULT_BATCH_OPTIONS,
  type BatchPlanOptions,
} from "../indexing/batching";

export type EmbedResult = {
  /** Row-major [count × dims]. */
  vectors: Float32Array;
  dims: number;
  count: number;
  workerStartedAt: number;
  embedsServed: number;
  backend: string;
  modelLoadMs: number;
  inferMs: number;
};

export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  const response = await callWorker({ type: "embed", texts });
  if (!response.ok) throw new Error(`embed failed: ${response.error}`);
  if (response.type !== "embed") throw new Error(`unexpected response ${response.type}`);
  return {
    vectors: Float32Array.from(response.vectors),
    dims: response.dims,
    count: texts.length,
    workerStartedAt: response.workerStartedAt,
    embedsServed: response.embedsServed,
    backend: response.backend,
    modelLoadMs: response.modelLoadMs,
    inferMs: response.inferMs,
  };
}

export type BatchedEmbedResult = EmbedResult & {
  /** Number of worker round-trips (batches) used. */
  batches: number;
};

/** Embeds many texts as length-sorted batches, streaming one batch per
 *  worker round-trip and scattering each batch's vectors back into the
 *  caller's original order. Memory stays bounded: only one batch of
 *  vectors crosses the boundary at a time, written into a single
 *  preallocated result buffer. */
export async function embedBatched(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
  options: BatchPlanOptions = DEFAULT_BATCH_OPTIONS,
): Promise<BatchedEmbedResult> {
  const plan = planBatches(texts, options);
  let out: Float32Array | null = null;
  let dims = 0;
  let done = 0;
  let inferMs = 0;
  let last: EmbedResult | null = null;

  for (const batch of plan) {
    const result = await embedTexts(batch.map((i) => texts[i]!));
    if (!out) {
      dims = result.dims;
      out = new Float32Array(texts.length * dims);
    }
    batch.forEach((originalIndex, j) => {
      out!.set(result.vectors.subarray(j * dims, (j + 1) * dims), originalIndex * dims);
    });
    inferMs += result.inferMs;
    last = result;
    done += batch.length;
    onProgress?.(done, texts.length);
  }

  return {
    vectors: out ?? new Float32Array(0),
    dims,
    count: texts.length,
    workerStartedAt: last?.workerStartedAt ?? 0,
    embedsServed: last?.embedsServed ?? 0,
    backend: last?.backend ?? "wasm",
    modelLoadMs: last?.modelLoadMs ?? 0,
    inferMs,
    batches: plan.length,
  };
}
