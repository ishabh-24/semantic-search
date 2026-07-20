import type { SearchHit } from "./types";

// Reciprocal Rank Fusion. Vector cosine scores and lexical BM25-ish scores
// live on incomparable scales, so fusing their raw numbers is meaningless.
// RRF instead fuses by RANK: an item's contribution from each list is
// 1/(k + rank), rank 1-based. k=60 is the standard damping constant — large
// enough that the gap between rank 1 and rank 2 doesn't dominate, so an item
// ranked decently by BOTH rankers beats one ranked #1 by only one. That is
// exactly the hybrid behavior we want.

export const DEFAULT_RRF_K = 60;

export type FusionOptions = {
  k?: number;
  /** Recency tie-break: id → timestamp (ms). Higher (newer) wins ties. */
  recencyOf?: (id: string) => number;
};

/** Fuses ranked lists into one, deduping by id (an id in multiple lists sums
 *  its per-list contributions). Sorted by fused score desc, ties broken by
 *  recency when provided. Input lists are assumed already ranked best-first. */
export function reciprocalRankFusion(
  lists: SearchHit[][],
  options: FusionOptions = {},
): SearchHit[] {
  const k = options.k ?? DEFAULT_RRF_K;
  const scores = new Map<string, number>();

  for (const list of lists) {
    list.forEach((hit, i) => {
      const rank = i + 1;
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + rank));
    });
  }

  const recencyOf = options.recencyOf;
  const fused = Array.from(scores, ([id, score]) => ({ id, score }));
  fused.sort((a, b) => {
    const byScore = b.score - a.score;
    if (Math.abs(byScore) > 1e-9) return byScore;
    return recencyOf ? recencyOf(b.id) - recencyOf(a.id) : 0;
  });
  return fused;
}
