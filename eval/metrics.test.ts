import { describe, expect, it } from "vitest";
import { recallAtK, reciprocalRank, mean, formatTable } from "./metrics";

describe("recallAtK", () => {
  it("is 1 when the single relevant doc is within top-k", () => {
    expect(recallAtK(["a", "b", "c"], new Set(["b"]), 5)).toBe(1);
  });

  it("is 0 when the relevant doc is outside top-k", () => {
    expect(recallAtK(["a", "b", "c", "d", "e", "f"], new Set(["f"]), 5)).toBe(0);
  });

  it("is the fraction found for multi-relevant queries", () => {
    expect(recallAtK(["a", "b", "c"], new Set(["a", "c", "z"]), 5)).toBeCloseTo(2 / 3, 6);
  });

  it("returns 0 for an empty relevant set", () => {
    expect(recallAtK(["a"], new Set(), 5)).toBe(0);
  });
});

describe("reciprocalRank", () => {
  it("is 1/rank of the first relevant hit", () => {
    expect(reciprocalRank(["a", "b", "c"], new Set(["c"]))).toBeCloseTo(1 / 3, 6);
    expect(reciprocalRank(["a", "b"], new Set(["a"]))).toBe(1);
  });

  it("is 0 when nothing relevant is ranked", () => {
    expect(reciprocalRank(["a", "b"], new Set(["z"]))).toBe(0);
  });
});

describe("mean & formatTable", () => {
  it("averages, and handles empty", () => {
    expect(mean([1, 0, 0.5])).toBeCloseTo(0.5, 6);
    expect(mean([])).toBe(0);
  });

  it("renders a table with all modes", () => {
    const table = formatTable([
      { mode: "lexical", recallAt1: 0.5, recallAt5: 0.6, mrr: 0.55 },
      { mode: "hybrid", recallAt1: 0.8, recallAt5: 0.9, mrr: 0.82 },
    ]);
    expect(table).toContain("recall@1");
    expect(table).toContain("recall@5");
    expect(table).toContain("lexical");
    expect(table).toContain("0.900");
  });
});
