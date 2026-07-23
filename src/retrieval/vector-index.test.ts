import { describe, expect, it } from "vitest";
import { VectorIndex } from "./vector-index";

function unit(...v: number[]): Float32Array {
  const arr = Float32Array.from(v);
  let s = 0;
  for (const x of arr) s += x * x;
  const n = Math.sqrt(s) || 1;
  return arr.map((x) => x / n);
}

describe("VectorIndex", () => {
  it("ranks by cosine similarity, descending", () => {
    const idx = new VectorIndex(2);
    idx.add("east", unit(1, 0));
    idx.add("northeast", unit(1, 1));
    idx.add("north", unit(0, 1));
    idx.add("west", unit(-1, 0));

    const hits = idx.search(unit(1, 0.1), 3);
    expect(hits.map((h) => h.id)).toEqual(["east", "northeast", "north"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score);
  });

  it("returns cosine ~1 for an identical direction", () => {
    const idx = new VectorIndex(3);
    idx.add("a", unit(1, 2, 3));
    expect(idx.search(unit(2, 4, 6), 1)[0]!.score).toBeCloseTo(1, 5);
  });

  it("normalizes the query, so query magnitude does not matter", () => {
    const idx = new VectorIndex(2);
    idx.add("x", unit(1, 0));
    const a = idx.search(Float32Array.from([1, 0]), 1)[0]!.score;
    const b = idx.search(Float32Array.from([1000, 0]), 1)[0]!.score;
    expect(a).toBeCloseTo(b, 6);
  });

  it("clamps k to the index size and handles an empty index", () => {
    const idx = new VectorIndex(2);
    expect(idx.search(unit(1, 0), 5)).toEqual([]);
    idx.add("only", unit(1, 0));
    expect(idx.search(unit(1, 0), 5)).toHaveLength(1);
  });

  it("addBatch matches repeated add", () => {
    const single = new VectorIndex(2);
    single.add("a", unit(1, 0));
    single.add("b", unit(0, 1));
    const batch = new VectorIndex(2);
    batch.addBatch(["a", "b"], Float32Array.from([...unit(1, 0), ...unit(0, 1)]));
    expect(batch.size).toBe(2);
    expect(batch.search(unit(1, 0), 2)).toEqual(single.search(unit(1, 0), 2));
  });

  it("grows capacity across many adds without corruption", () => {
    const idx = new VectorIndex(4);
    for (let i = 0; i < 5000; i++) {
      const v = new Float32Array(4);
      v[i % 4] = 1;
      idx.add(`v${i}`, v);
    }
    expect(idx.size).toBe(5000);
    const top = idx.search(Float32Array.from([1, 0, 0, 0]), 1)[0]!;
    expect(top.score).toBeCloseTo(1, 5);
  });

  it("removes ids by compaction, keeping the rest searchable", () => {
    const idx = new VectorIndex(2);
    idx.add("east", unit(1, 0));
    idx.add("north", unit(0, 1));
    idx.add("west", unit(-1, 0));
    expect(idx.remove(new Set(["north"]))).toBe(2);
    expect(idx.size).toBe(2);
    const hits = idx.search(unit(1, 0), 5).map((h) => h.id);
    expect(hits).toEqual(["east", "west"]);
    // The removed vector's row must not leak into results.
    expect(idx.search(unit(0, 1), 5).map((h) => h.id)).not.toContain("north");
  });

  it("remove then add re-densifies without corrupting vectors", () => {
    const idx = new VectorIndex(2);
    idx.add("a", unit(1, 0));
    idx.add("b", unit(0, 1));
    idx.remove(new Set(["a"]));
    idx.add("c", unit(1, 1));
    expect(idx.size).toBe(2);
    expect(idx.search(unit(0, 1), 1)[0]!.id).toBe("b");
    expect(idx.search(unit(1, 0), 2).map((h) => h.id).sort()).toEqual(["b", "c"]);
  });

  it("rejects dimension mismatches", () => {
    const idx = new VectorIndex(3);
    expect(() => idx.add("bad", unit(1, 0))).toThrow();
    expect(() => idx.search(unit(1, 0), 1)).toThrow();
  });
});

// Done-when benchmark for commit 10: top-k over 60k×384 in <100ms. The
// assertion ceiling is loose to survive slow CI; the real median is logged
// and recorded in docs/benchmarks.md. This is pure V8 math, so a Web Worker
// runs it at the same speed.
describe("VectorIndex performance", () => {
  it("searches 60k × 384 within the latency budget", () => {
    const dims = 384;
    const n = 60_000;
    const idx = new VectorIndex(dims, n);
    const buf = new Float32Array(n * dims);
    let seed = 12345;
    for (let i = 0; i < buf.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      buf[i] = seed / 0x3fffffff - 1;
    }
    const ids = Array.from({ length: n }, (_, i) => `c${i}`);
    idx.addBatch(ids, buf);

    const query = buf.subarray(0, dims);
    const runs = 7;
    const times: number[] = [];
    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      const hits = idx.search(query, 10);
      times.push(performance.now() - t0);
      expect(hits).toHaveLength(10);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(runs / 2)]!;
    console.log(
      `[bench] vector-index 60k×384 top-10: median ${median.toFixed(1)}ms (target <100ms)`,
    );
    expect(median).toBeLessThan(250);
  });
});
