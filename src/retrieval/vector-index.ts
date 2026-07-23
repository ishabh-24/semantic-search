// In-memory vector index: a flat Float32Array of row-major vectors plus a
// parallel array of chunk ids. Stored vectors are assumed L2-normalized
// (the embedder emits unit vectors), so cosine similarity is a plain dot
// product — the single hottest loop in retrieval. Brute force is
// deliberate: at personal-Drive scale (~50–200k chunks) a linear scan is
// well under the latency budget and needs no ANN structure to maintain.

import type { SearchHit } from "./types";
export type { SearchHit };

export class VectorIndex {
  readonly dims: number;
  private data: Float32Array;
  private ids: string[] = [];
  private count = 0;

  constructor(dims: number, capacity = 0) {
    this.dims = dims;
    this.data = new Float32Array(capacity * dims);
  }

  get size(): number {
    return this.count;
  }

  /** Copies out the stored ids and row-major vectors (used to serialize the
   *  index). Ids are aligned to vectors. */
  snapshot(): { ids: string[]; vectors: Float32Array } {
    return {
      ids: this.ids.slice(0, this.count),
      vectors: this.data.slice(0, this.count * this.dims),
    };
  }

  add(id: string, vector: ArrayLike<number>): void {
    if (vector.length !== this.dims) {
      throw new Error(`vector length ${vector.length} != dims ${this.dims}`);
    }
    this.ensureCapacity(this.count + 1);
    this.data.set(vector, this.count * this.dims);
    this.ids.push(id);
    this.count++;
  }

  /** Removes the given ids by compacting the flat array in place (kept rows
   *  shift down over removed ones). Returns the new size. O(size). */
  remove(ids: ReadonlySet<string>): number {
    if (ids.size === 0) return this.count;
    const { dims } = this;
    let write = 0;
    for (let read = 0; read < this.count; read++) {
      if (ids.has(this.ids[read]!)) continue;
      if (write !== read) {
        this.data.copyWithin(write * dims, read * dims, (read + 1) * dims);
        this.ids[write] = this.ids[read]!;
      }
      write++;
    }
    this.ids.length = write;
    this.count = write;
    return this.count;
  }

  /** Bulk append; `vectors` is row-major [ids.length × dims]. */
  addBatch(ids: string[], vectors: Float32Array): void {
    if (vectors.length !== ids.length * this.dims) {
      throw new Error(`vectors length ${vectors.length} != ${ids.length} × ${this.dims}`);
    }
    this.ensureCapacity(this.count + ids.length);
    this.data.set(vectors, this.count * this.dims);
    for (const id of ids) this.ids.push(id);
    this.count += ids.length;
  }

  /** Top-k by cosine similarity (dot product on unit vectors), descending.
   *  The query is normalized defensively; stored vectors are trusted unit. */
  search(query: ArrayLike<number>, k: number): SearchHit[] {
    if (query.length !== this.dims) {
      throw new Error(`query length ${query.length} != dims ${this.dims}`);
    }
    const { dims, data, count } = this;
    const limit = Math.min(k, count);
    if (limit <= 0) return [];

    const q = normalizeCopy(query, dims);

    // Bounded top-k: an unsorted window of `limit` best-so-far, tracking
    // the current worst slot. A candidate only displaces the worst, so the
    // O(limit) argmin runs only on genuine improvements — rare after warmup,
    // leaving the dot-product loop as the dominant cost.
    const bestScore = new Float32Array(limit);
    const bestIdx = new Int32Array(limit);
    let filled = 0;
    let worst = 0;

    for (let i = 0; i < count; i++) {
      let dot = 0;
      const base = i * dims;
      for (let d = 0; d < dims; d++) dot += data[base + d]! * q[d]!;

      if (filled < limit) {
        bestScore[filled] = dot;
        bestIdx[filled] = i;
        filled++;
        if (filled === limit) worst = argmin(bestScore);
      } else if (dot > bestScore[worst]!) {
        bestScore[worst] = dot;
        bestIdx[worst] = i;
        worst = argmin(bestScore);
      }
    }

    const hits: SearchHit[] = [];
    for (let j = 0; j < filled; j++) {
      hits.push({ id: this.ids[bestIdx[j]!]!, score: bestScore[j]! });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  private ensureCapacity(needed: number): void {
    const have = Math.floor(this.data.length / this.dims);
    if (needed <= have) return;
    let next = Math.max(have, 1024);
    while (next < needed) next *= 2;
    const grown = new Float32Array(next * this.dims);
    grown.set(this.data.subarray(0, this.count * this.dims));
    this.data = grown;
  }
}

function normalizeCopy(vector: ArrayLike<number>, dims: number): Float32Array {
  const out = new Float32Array(dims);
  let sumSquares = 0;
  for (let d = 0; d < dims; d++) {
    const v = vector[d]!;
    out[d] = v;
    sumSquares += v * v;
  }
  const norm = Math.sqrt(sumSquares) || 1;
  for (let d = 0; d < dims; d++) out[d]! /= norm;
  return out;
}

function argmin(values: Float32Array): number {
  let min = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i]! < values[min]!) min = i;
  }
  return min;
}
