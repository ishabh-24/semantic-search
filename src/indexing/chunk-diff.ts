// Chunk-level diffing for incremental sync. When a doc is modified we re-chunk
// it and want to re-embed only the chunks whose *content* actually changed,
// reusing the existing vector for any chunk whose text is unchanged.
//
// Matching is by content (chunk text), not by position/id: chunk ids are
// `${docId}:${seq}`, so inserting a paragraph shifts every later chunk's id
// even though its text is identical. Keying reuse on text (which the Map hashes
// internally) makes that a no-op instead of a full re-embed.

export type ReusePlan = {
  /** Aligned to the new chunks: the existing vector to reuse, or null if the
   *  chunk's text is new/changed and must be embedded. */
  reuse: (Float32Array | null)[];
  reuseCount: number;
  embedCount: number;
};

export function diffChunks(
  newTexts: string[],
  existingByText: ReadonlyMap<string, Float32Array>,
): ReusePlan {
  const reuse = newTexts.map((text) => existingByText.get(text) ?? null);
  let reuseCount = 0;
  for (const v of reuse) if (v !== null) reuseCount++;
  return { reuse, reuseCount, embedCount: newTexts.length - reuseCount };
}
