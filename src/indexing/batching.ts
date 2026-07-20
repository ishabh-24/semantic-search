// Pure batch planning for embedding. Transformers.js pads every text in a
// batch to the longest member, so a batch mixing one long text with many
// short ones wastes compute on padding. Sorting globally by length first,
// then slicing into batches, groups similar-length texts together and
// drives padding waste toward zero. Char length is the token proxy (same
// chars÷4 assumption as the chunker) — no tokenizer dependency here.

export type BatchPlanOptions = {
  /** Upper bound on texts per batch. */
  maxBatchSize: number;
  /** Memory ceiling: a batch won't exceed this many total chars unless a
   *  single text already does (that text then forms its own batch). */
  maxBatchChars: number;
  /** Length-sort before batching (the padding optimization). Off yields
   *  original-order batches — used only for the benchmark baseline. */
  sort: boolean;
};

export const DEFAULT_BATCH_OPTIONS: BatchPlanOptions = {
  maxBatchSize: 32,
  maxBatchChars: 16000,
  sort: true,
};

/** Returns batches of original indices. Every index in [0, texts.length)
 *  appears in exactly one batch. Order within/across batches is by length
 *  when sorting; otherwise input order. */
export function planBatches(texts: string[], options: BatchPlanOptions): number[][] {
  const order = texts.map((_, i) => i);
  if (options.sort) {
    order.sort((a, b) => texts[a]!.length - texts[b]!.length);
  }

  const batches: number[][] = [];
  let current: number[] = [];
  let currentChars = 0;

  for (const index of order) {
    const len = texts[index]!.length;
    const wouldExceed =
      current.length >= options.maxBatchSize || currentChars + len > options.maxBatchChars;
    // The `current.length > 0` guard lets a single oversized text through
    // as its own batch instead of being dropped or looping forever.
    if (wouldExceed && current.length > 0) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(index);
    currentChars += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
