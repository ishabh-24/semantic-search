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
