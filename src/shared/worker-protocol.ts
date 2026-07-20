// Protocol between the offscreen document and the retrieval Web Worker
// (structured clone + transferables — no Chrome APIs on this boundary).
// Chrome-free so both the DOM and WebWorker tsconfigs can import it.

/** A chunk plus the doc-level metadata needed to index and display it.
 *  Sent SW → worker; the worker embeds the text and keeps the record so
 *  vectors never leave the worker. */
export type ChunkRecord = {
  /** `${docId}:${seq}`. */
  id: string;
  docId: string;
  docName: string;
  breadcrumbs: string[];
  text: string;
  /** RFC 3339 modifiedTime, for the recency tie-break in fusion. */
  modifiedTime: string;
};

/** A doc-level search result (best chunk per document). */
export type DocHit = {
  docId: string;
  docName: string;
  breadcrumbs: string[];
  snippet: string;
  score: number;
  chunkId: string;
};

export type WorkerRequest =
  | { id: number; type: "embed"; texts: string[] }
  | { id: number; type: "index.add"; chunks: ChunkRecord[] }
  | { id: number; type: "search"; query: string; k: number }
  | { id: number; type: "index.stats" };

export type WorkerResponse =
  | {
      id: number;
      ok: true;
      type: "embed";
      dims: number;
      /** Row-major [texts.length × dims], transferred, not copied. */
      vectors: Float32Array;
      workerStartedAt: number;
      embedsServed: number;
      backend: string;
      modelLoadMs: number;
      inferMs: number;
    }
  | { id: number; ok: true; type: "index.add"; indexSize: number }
  | { id: number; ok: true; type: "search"; hits: DocHit[]; indexSize: number }
  | { id: number; ok: true; type: "index.stats"; indexSize: number; backend: string }
  | { id: number; ok: false; error: string };
