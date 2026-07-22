import { describe, expect, it } from "vitest";
import {
  serializeIndex,
  deserializeIndex,
  IndexFormatError,
  FORMAT_VERSION,
  type IndexSnapshot,
} from "./index-format";
import { VectorIndex } from "../retrieval/vector-index";
import type { ChunkRecord } from "../shared/worker-protocol";

const DIMS = 384;

// Seeded LCG so tests are deterministic (no Math.random).
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x3fffffff - 1;
  };
}

function unitVectors(count: number, dims: number, seed: number): Float32Array {
  const rng = makeRng(seed);
  const out = new Float32Array(count * dims);
  for (let r = 0; r < count; r++) {
    let sumSq = 0;
    for (let d = 0; d < dims; d++) {
      const v = rng();
      out[r * dims + d] = v;
      sumSq += v * v;
    }
    const norm = Math.sqrt(sumSq) || 1;
    for (let d = 0; d < dims; d++) out[r * dims + d]! /= norm;
  }
  return out;
}

function makeChunks(count: number, textLen = 0): ChunkRecord[] {
  const vocab = "planning budget hiring roadmap revenue customer roadmap design launch review".split(" ");
  return Array.from({ length: count }, (_, i) => {
    let text = `Chunk ${i} content.`;
    if (textLen > 0) {
      const words: string[] = [];
      const rng = makeRng(i + 1);
      while (words.join(" ").length < textLen) {
        words.push(vocab[Math.floor(((rng() + 1) / 2) * vocab.length)] ?? "text");
      }
      text = words.join(" ");
    }
    return {
      id: `d${i % 50}:${i}`,
      docId: `d${i % 50}`,
      docName: `Doc ${i % 50}`,
      breadcrumbs: ["Section", `Sub ${i % 7}`],
      text,
      modifiedTime: "2026-01-01T00:00:00.000Z",
    };
  });
}

function snapshot(count: number, seed: number, textLen = 0): IndexSnapshot {
  return {
    modelId: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    dims: DIMS,
    vectors: unitVectors(count, DIMS, seed),
    chunks: makeChunks(count, textLen),
  };
}

describe("index-format round-trip", () => {
  it("preserves the header, model stamp, and chunk records exactly", async () => {
    const snap = snapshot(20, 7, 40);
    const back = await deserializeIndex(await serializeIndex(snap));
    expect(back.dims).toBe(DIMS);
    expect(back.modelId).toBe(snap.modelId);
    expect(back.revision).toBe(snap.revision);
    expect(back.chunks).toEqual(snap.chunks);
  });

  it("preserves top-5 ranking within noise of float32 (recall@5 ≈ 1)", async () => {
    const snap = snapshot(2000, 42);
    const back = await deserializeIndex(await serializeIndex(snap));

    const ids = snap.chunks.map((c) => c.id);
    const floatIdx = new VectorIndex(DIMS);
    floatIdx.addBatch(ids, snap.vectors);
    const quantIdx = new VectorIndex(DIMS);
    quantIdx.addBatch(ids, back.vectors);

    const rng = makeRng(99);
    let recallSum = 0;
    const queries = 40;
    for (let q = 0; q < queries; q++) {
      const query = new Float32Array(DIMS);
      for (let d = 0; d < DIMS; d++) query[d] = rng();
      const truth = new Set(floatIdx.search(query, 5).map((h) => h.id));
      const got = quantIdx.search(query, 5).map((h) => h.id);
      recallSum += got.filter((id) => truth.has(id)).length / 5;
    }
    const recall = recallSum / queries;
    console.log(`[bench] serialization recall@5 = ${recall.toFixed(4)}`);
    expect(recall).toBeGreaterThan(0.95);
  });

  it("serializes a 60k × 384 index under ~30MB", async () => {
    // ~200 chars of natural-ish text per chunk, so gzip is representative.
    const buffer = await serializeIndex(snapshot(60_000, 1, 200));
    const mb = buffer.byteLength / (1024 * 1024);
    console.log(`[bench] serialized 60k × 384 index = ${mb.toFixed(1)}MB`);
    expect(mb).toBeLessThanOrEqual(30);
  });
});

describe("index-format integrity", () => {
  it("rejects a blob with bad magic", async () => {
    const buffer = await serializeIndex(snapshot(5, 1, 20));
    new Uint8Array(buffer)[0] = 0x00;
    await expect(deserializeIndex(buffer)).rejects.toBeInstanceOf(IndexFormatError);
  });

  it("rejects a corrupted payload via checksum", async () => {
    const buffer = await serializeIndex(snapshot(5, 1, 20));
    const bytes = new Uint8Array(buffer);
    bytes[bytes.length - 1]! ^= 0xff; // flip a byte in the gzipped text
    await expect(deserializeIndex(buffer)).rejects.toThrow(/checksum/);
  });

  it("rejects an unsupported format version", async () => {
    const buffer = await serializeIndex(snapshot(5, 1, 20));
    new DataView(buffer).setUint16(4, FORMAT_VERSION + 1, true);
    await expect(deserializeIndex(buffer)).rejects.toThrow(/version/);
  });
});

describe("VectorIndex.snapshot", () => {
  it("round-trips through serialization to an equivalent index", async () => {
    const snap = snapshot(300, 5);
    const idx = new VectorIndex(DIMS);
    idx.addBatch(
      snap.chunks.map((c) => c.id),
      snap.vectors,
    );
    const exported = idx.snapshot();
    expect(exported.ids).toEqual(snap.chunks.map((c) => c.id));

    const back = await deserializeIndex(
      await serializeIndex({ ...snap, vectors: exported.vectors }),
    );
    const rebuilt = new VectorIndex(DIMS);
    rebuilt.addBatch(back.chunks.map((c) => c.id), back.vectors);
    const query = snap.vectors.subarray(0, DIMS);
    expect(rebuilt.search(query, 1)[0]!.id).toBe(idx.search(query, 1)[0]!.id);
  });
});
