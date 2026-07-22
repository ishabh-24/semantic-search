// Retrieval quality metrics, computed over doc-level rankings. Pure so they
// can be unit-tested independently of the model.

export type ModeScore = { mode: string; recallAt1: number; recallAt5: number; mrr: number };

/** Fraction of a query's relevant docs that appear in the top-k. For the
 *  common single-relevant-doc query this is 1 if the doc is in the top-k,
 *  else 0. */
export function recallAtK(ranked: string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevant.has(ranked[i]!)) hits++;
  }
  return hits / relevant.size;
}

/** 1 / rank of the first relevant doc (rank is 1-based); 0 if none found. */
export function reciprocalRank(ranked: string[], relevant: ReadonlySet<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Renders a small aligned table for the console / README. */
export function formatTable(scores: ModeScore[]): string {
  const header = ["mode", "recall@1", "recall@5", "MRR"];
  const rows = scores.map((s) => [
    s.mode,
    s.recallAt1.toFixed(3),
    s.recallAt5.toFixed(3),
    s.mrr.toFixed(3),
  ]);
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
  const line = (cells: string[]) => cells.map((cell, c) => cell.padEnd(widths[c]!)).join("  ");
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}
