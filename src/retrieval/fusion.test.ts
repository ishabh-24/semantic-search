import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, DEFAULT_RRF_K } from "./fusion";
import type { SearchHit } from "./types";

const hits = (...ids: string[]): SearchHit[] => ids.map((id, i) => ({ id, score: 1 - i * 0.01 }));

describe("reciprocalRankFusion", () => {
  it("ranks an item found by both rankers above items found by only one", () => {
    const vector = hits("a", "b", "c"); // 'b' is mid-rank here
    const lexical = hits("b", "d", "e"); // and top here
    const fused = reciprocalRankFusion([vector, lexical]);
    // 'b' appears in both → should win over 'a' (only vector, rank 1).
    expect(fused[0]!.id).toBe("b");
  });

  it("sums contributions for a shared id", () => {
    const fused = reciprocalRankFusion([hits("x"), hits("x")], { k: 60 });
    expect(fused).toHaveLength(1);
    expect(fused[0]!.score).toBeCloseTo(2 / (60 + 1), 9);
  });

  it("uses 1/(k+rank) with the default k", () => {
    const fused = reciprocalRankFusion([hits("only")]);
    expect(fused[0]!.score).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 9);
  });

  it("dedupes across lists (union, not concatenation)", () => {
    const fused = reciprocalRankFusion([hits("a", "b"), hits("b", "c")]);
    expect(fused.map((h) => h.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("breaks score ties by recency when provided", () => {
    // Two items each ranked #1 in exactly one list → identical RRF scores.
    const fused = reciprocalRankFusion([hits("old"), hits("new")], {
      recencyOf: (id) => (id === "new" ? 2000 : 1000),
    });
    expect(fused[0]!.id).toBe("new");
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 9);
  });

  it("handles empty input and empty lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it("k controls the rank-1 vs found-by-both tradeoff", () => {
    const l1 = hits("top", "a", "b", "c", "both"); // 'both' at rank 5
    const l2 = hits("d", "e", "f", "g", "both"); // 'both' at rank 5
    // Default k=60: appearing in both lists (2/65) beats a lone rank-1 (1/61).
    expect(reciprocalRankFusion([l1, l2])[0]!.id).toBe("both");
    // k=1: a single rank-1 (1/2) beats two rank-5s (2/6).
    expect(reciprocalRankFusion([l1, l2], { k: 1 })[0]!.id).toBe("top");
  });
});
