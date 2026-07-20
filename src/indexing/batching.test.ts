import { describe, expect, it } from "vitest";
import { planBatches, type BatchPlanOptions } from "./batching";

const OPTS: BatchPlanOptions = { maxBatchSize: 4, maxBatchChars: 1000, sort: true };

function covers(batches: number[][], n: number): void {
  const flat = batches.flat().sort((a, b) => a - b);
  expect(flat).toEqual(Array.from({ length: n }, (_, i) => i));
}

describe("planBatches", () => {
  it("returns no batches for empty input", () => {
    expect(planBatches([], OPTS)).toEqual([]);
  });

  it("covers every index exactly once", () => {
    const texts = Array.from({ length: 37 }, (_, i) => "x".repeat((i % 5) + 1));
    covers(planBatches(texts, OPTS), 37);
  });

  it("respects the max batch size", () => {
    const texts = Array.from({ length: 20 }, () => "aa");
    for (const batch of planBatches(texts, OPTS)) {
      expect(batch.length).toBeLessThanOrEqual(OPTS.maxBatchSize);
    }
  });

  it("respects the char ceiling", () => {
    const texts = Array.from({ length: 10 }, () => "x".repeat(400)); // 2 per 1000-char batch
    const batches = planBatches(texts, { ...OPTS, maxBatchSize: 100 });
    for (const batch of batches) {
      const chars = batch.reduce((sum, i) => sum + texts[i]!.length, 0);
      expect(chars).toBeLessThanOrEqual(OPTS.maxBatchChars);
    }
  });

  it("lets a single oversized text form its own batch", () => {
    const texts = ["short", "x".repeat(5000), "also short"];
    const batches = planBatches(texts, { ...OPTS, maxBatchSize: 100 });
    const big = batches.find((b) => b.includes(1))!;
    expect(big).toEqual([1]);
    covers(batches, 3);
  });

  it("sorts by length so batches group similar sizes", () => {
    const texts = ["ccc", "a", "bbbbb", "dd", "eeee"]; // lengths 3,1,5,2,4
    const batches = planBatches(texts, { maxBatchSize: 2, maxBatchChars: 1000, sort: true });
    // Sorted order of indices by length: 1(1),3(2),0(3),4(4),2(5)
    expect(batches).toEqual([
      [1, 3],
      [0, 4],
      [2],
    ]);
  });

  it("preserves input order when sort is off", () => {
    const texts = ["ccc", "a", "bbbbb", "dd", "eeee"];
    const batches = planBatches(texts, { maxBatchSize: 2, maxBatchChars: 1000, sort: false });
    expect(batches).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
  });
});
