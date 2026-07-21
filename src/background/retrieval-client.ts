import { callWorker } from "./offscreen-client";
import type { ChunkRecord, DocHit } from "../shared/worker-protocol";

// SW-side API for the worker's in-memory hybrid index. Chunk text goes in;
// the worker embeds and indexes it (vectors never come back). Queries go in;
// ranked doc-level hits come back.

/** Adds a slice of chunks to the index; returns the new total index size. */
export async function indexChunks(chunks: ChunkRecord[]): Promise<number> {
  const response = await callWorker({ type: "index.add", chunks });
  if (!response.ok) throw new Error(`index.add failed: ${response.error}`);
  if (response.type !== "index.add") throw new Error(`unexpected response ${response.type}`);
  return response.indexSize;
}

export async function searchDocs(
  query: string,
  k: number,
): Promise<{ hits: DocHit[]; indexSize: number }> {
  const response = await callWorker({ type: "search", query, k });
  if (!response.ok) throw new Error(`search failed: ${response.error}`);
  if (response.type !== "search") throw new Error(`unexpected response ${response.type}`);
  return { hits: response.hits, indexSize: response.indexSize };
}

/** Current worker index size, backend, and instance id. The instance id
 *  lets the indexer detect a wiped index (worker restart) before trusting a
 *  persisted resume cursor. */
export async function indexStats(): Promise<{
  indexSize: number;
  backend: string;
  workerStartedAt: number;
}> {
  const response = await callWorker({ type: "index.stats" });
  if (!response.ok) throw new Error(`index.stats failed: ${response.error}`);
  if (response.type !== "index.stats") throw new Error(`unexpected response ${response.type}`);
  return {
    indexSize: response.indexSize,
    backend: response.backend,
    workerStartedAt: response.workerStartedAt,
  };
}
