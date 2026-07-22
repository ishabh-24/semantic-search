# Benchmarks

Reproducible performance numbers backing the design claims. Regenerate with
the commands shown; these feed the README's eval/perf section (commit 20).

## Vector index — brute-force cosine top-k

**Claim (commit 10):** brute force is sufficient at personal-Drive scale
(~50–200k chunks); no ANN index needed.

| Corpus | Dims | k | Median search | Target |
|--------|------|---|---------------|--------|
| 60,000 | 384 | 10 | **15.5 ms** | <100 ms |

- Machine: Apple Silicon (darwin), Node 22 / V8 — single-threaded JS. A Web
  Worker runs identical V8, so in-extension latency matches.
- Method: `src/retrieval/vector-index.test.ts` → "VectorIndex performance",
  median of 7 runs after fill. Run: `npm test` (or `npx vitest run
  src/retrieval/vector-index.test.ts --reporter=verbose` to see the line).
- Headroom: 15.5 ms at 60k ⇒ well under budget even at the 200k top of the
  targeted range (cost is linear in corpus size).

## Index serialization (int8 + gzip)

**Claim (commit 15):** a serialized 60k-chunk index is ≤ ~30MB and int8
quantization preserves recall@5 within noise of float32.

| Corpus | Serialized size | recall@5 vs float32 |
|--------|-----------------|---------------------|
| 60,000 × 384 | **23.9 MB** | **0.995** |

- Method: `src/persistence/index-format.test.ts`. Size uses ~200 chars of
  natural-ish text per chunk (representative gzip ratio); recall averages
  top-5 overlap over 40 random queries, float32 index vs dequantized.
- Breakdown at 60k: int8 vectors + per-vector scales ≈ 23.3MB fixed; gzipped
  chunk text ≈ the remainder. Vectors dominate, so size scales ~linearly.

