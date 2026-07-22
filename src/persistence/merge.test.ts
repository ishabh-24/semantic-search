import { describe, expect, it } from "vitest";
import { mergeSnapshots } from "./merge";
import type { IndexSnapshot } from "./index-format";
import type { ChunkRecord } from "../shared/worker-protocol";

const DIMS = 4;

// A doc with `n` chunks at revision `time`; each chunk's vector encodes its
// identity (docId hash in dim 0, chunk index in dim 1) so we can assert which
// version's vectors survived.
function doc(docId: string, n: number, time: string): { chunks: ChunkRecord[]; vectors: number[] } {
  const chunks: ChunkRecord[] = [];
  const vectors: number[] = [];
  for (let i = 0; i < n; i++) {
    chunks.push({
      id: `${docId}:${i}`,
      docId,
      docName: `Doc ${docId}`,
      breadcrumbs: [],
      text: `${docId} chunk ${i} @ ${time}`,
      modifiedTime: time,
    });
    vectors.push(docId.charCodeAt(0), i, time.length, 0);
  }
  return { chunks, vectors };
}

function snapshot(...docs: { chunks: ChunkRecord[]; vectors: number[] }[]): IndexSnapshot {
  const chunks = docs.flatMap((d) => d.chunks);
  const vectors = Float32Array.from(docs.flatMap((d) => d.vectors));
  return { modelId: "m", revision: "r", dims: DIMS, vectors, chunks };
}

const docIds = (s: IndexSnapshot) => [...new Set(s.chunks.map((c) => c.docId))].sort();
const chunkIds = (s: IndexSnapshot) => s.chunks.map((c) => c.id).sort();

describe("mergeSnapshots", () => {
  it("unions disjoint documents", () => {
    const a = snapshot(doc("1", 2, "2026-01-01T00:00:00Z"));
    const b = snapshot(doc("2", 3, "2026-01-01T00:00:00Z"));
    const merged = mergeSnapshots(a, b);
    expect(docIds(merged)).toEqual(["1", "2"]);
    expect(merged.chunks).toHaveLength(5);
    expect(merged.vectors.length).toBe(5 * DIMS);
  });

  it("keeps the newer revision of a shared doc (last-write-wins per doc)", () => {
    const older = snapshot(doc("1", 2, "2026-01-01T00:00:00Z"));
    const newer = snapshot(doc("1", 4, "2026-06-01T00:00:00Z"));
    const merged = mergeSnapshots(older, newer);
    // doc 1 should be the 4-chunk (newer) version, not the 2-chunk one.
    expect(merged.chunks.filter((c) => c.docId === "1")).toHaveLength(4);
    expect(merged.chunks.every((c) => c.text.includes("2026-06-01"))).toBe(true);
  });

  it("keeps newer per-doc while unioning the rest", () => {
    const a = snapshot(doc("1", 2, "2026-01-01T00:00:00Z"), doc("2", 1, "2026-02-01T00:00:00Z"));
    const b = snapshot(doc("2", 3, "2026-05-01T00:00:00Z"), doc("3", 1, "2026-01-01T00:00:00Z"));
    const merged = mergeSnapshots(a, b);
    expect(docIds(merged)).toEqual(["1", "2", "3"]);
    expect(merged.chunks.filter((c) => c.docId === "2")).toHaveLength(3); // newer wins
    expect(merged.vectors.length).toBe(merged.chunks.length * DIMS);
  });

  it("converges regardless of merge order (same union both ways)", () => {
    const a = snapshot(doc("1", 2, "2026-01-01T00:00:00Z"), doc("2", 1, "2026-02-01T00:00:00Z"));
    const b = snapshot(doc("2", 3, "2026-05-01T00:00:00Z"), doc("3", 2, "2026-03-01T00:00:00Z"));
    const ab = mergeSnapshots(a, b);
    const ba = mergeSnapshots(b, a);
    expect(docIds(ab)).toEqual(docIds(ba));
    expect(chunkIds(ab)).toEqual(chunkIds(ba));
    // doc 2's newer (3-chunk) revision wins in both orderings.
    expect(ab.chunks.filter((c) => c.docId === "2")).toHaveLength(3);
    expect(ba.chunks.filter((c) => c.docId === "2")).toHaveLength(3);
  });

  it("is idempotent when merging a snapshot with itself", () => {
    const a = snapshot(doc("1", 2, "2026-01-01T00:00:00Z"), doc("2", 3, "2026-02-01T00:00:00Z"));
    const merged = mergeSnapshots(a, a);
    expect(chunkIds(merged)).toEqual(chunkIds(a));
    expect(merged.vectors.length).toBe(a.vectors.length);
  });

  it("never corrupts vector/chunk alignment", () => {
    const a = snapshot(doc("1", 5, "2026-01-01T00:00:00Z"));
    const b = snapshot(doc("1", 2, "2026-09-01T00:00:00Z"), doc("2", 4, "2026-01-01T00:00:00Z"));
    const merged = mergeSnapshots(a, b);
    expect(merged.vectors.length).toBe(merged.chunks.length * DIMS);
  });
});
