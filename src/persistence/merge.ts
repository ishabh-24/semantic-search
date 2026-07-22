import type { IndexSnapshot } from "./index-format";
import type { ChunkRecord } from "../shared/worker-protocol";

// Merges two index snapshots that diverged on separate devices. The unit of
// reconciliation is a document: chunks are grouped by docId, and for each
// docId the newer revision wins (last-write-wins by modifiedTime — the doc's
// Drive revision proxy). The result is the UNION of documents, so a doc
// indexed on one device is never lost just because the other device hadn't
// seen it. Documents are all-or-nothing (a doc's chunks always travel
// together with their vectors), which is what keeps a merge from producing a
// half-updated document.
//
// The merge converges: because every save re-merges against whatever is
// currently in Drive, concurrent writers arrive at the same union. Ties on
// modifiedTime mean the same doc revision (deterministic chunking ⇒ identical
// chunks), so the tiebreak choice doesn't affect the result.

export function mergeSnapshots(a: IndexSnapshot, b: IndexSnapshot): IndexSnapshot {
  const dims = a.dims;
  if (b.dims !== dims) throw new Error(`cannot merge snapshots of differing dims (${a.dims} vs ${b.dims})`);

  type Winner = { modifiedTime: string; snap: IndexSnapshot; rows: number[] };
  const byDoc = new Map<string, Winner>();

  const consider = (snap: IndexSnapshot) => {
    const rowsByDoc = new Map<string, number[]>();
    snap.chunks.forEach((c, i) => {
      const rows = rowsByDoc.get(c.docId);
      if (rows) rows.push(i);
      else rowsByDoc.set(c.docId, [i]);
    });
    for (const [docId, rows] of rowsByDoc) {
      const modifiedTime = snap.chunks[rows[0]!]!.modifiedTime;
      const existing = byDoc.get(docId);
      if (!existing || modifiedTime > existing.modifiedTime) {
        byDoc.set(docId, { modifiedTime, snap, rows });
      }
    }
  };
  consider(a);
  consider(b);

  const chunks: ChunkRecord[] = [];
  let totalRows = 0;
  for (const w of byDoc.values()) totalRows += w.rows.length;
  const vectors = new Float32Array(totalRows * dims);
  let offset = 0;
  for (const { snap, rows } of byDoc.values()) {
    for (const r of rows) {
      chunks.push(snap.chunks[r]!);
      vectors.set(snap.vectors.subarray(r * dims, (r + 1) * dims), offset);
      offset += dims;
    }
  }

  return { modelId: a.modelId, revision: a.revision, dims, vectors, chunks };
}
