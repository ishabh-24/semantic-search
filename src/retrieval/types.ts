// Shared retrieval types. A SearchHit is the common currency between the
// vector index, the lexical index, and rank fusion: an id and a score whose
// scale is meaningful only within its own ranker (cosine for vectors, BM25-
// ish for lexical), which is exactly why fusion uses ranks, not raw scores.
export type SearchHit = { id: string; score: number };
