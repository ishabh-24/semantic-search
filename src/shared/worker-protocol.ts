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
  // Re-index a modified/added doc, re-embedding only its changed chunks.
  | { id: number; type: "index.update"; chunks: ChunkRecord[] }
  | { id: number; type: "search"; query: string; k: number }
  | { id: number; type: "index.stats" }
  // Remove all chunks belonging to the given documents (deletions, or the old
  // version of a doc about to be re-added by incremental sync).
  | { id: number; type: "index.remove"; docIds: string[] }
  // SW injects a fresh OAuth token; the worker does the Drive I/O itself so
  // the ~24MB blob never crosses a message boundary.
  | { id: number; type: "index.save"; token: string }
  | { id: number; type: "index.load"; token: string };

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
  | { id: number; ok: true; type: "index.remove"; indexSize: number }
  | {
      id: number;
      ok: true;
      type: "index.update";
      indexSize: number;
      /** Chunks actually re-embedded vs reused from the prior version. */
      embedded: number;
      reused: number;
    }
  | { id: number; ok: true; type: "search"; hits: DocHit[]; indexSize: number }
  | {
      id: number;
      ok: true;
      type: "index.stats";
      indexSize: number;
      /** Distinct documents represented in the index. */
      docCount: number;
      backend: string;
      /** Identifies the worker instance holding this in-memory index. If it
       *  changes, the index was wiped (worker/browser restart) and a resumed
       *  job must re-index rather than trust its cursor. */
      workerStartedAt: number;
    }
  | { id: number; ok: true; type: "index.save"; fileId: string; sizeBytes: number }
  | {
      id: number;
      ok: true;
      type: "index.load";
      /** False when nothing was restored (no saved blob, corrupt, or a
       *  different embedding model); reason explains why. */
      loaded: boolean;
      indexSize: number;
      docCount: number;
      reason?: string;
    }
  | { id: number; ok: false; error: string };
