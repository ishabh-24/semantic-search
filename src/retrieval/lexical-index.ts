import MiniSearch from "minisearch";
import type { SearchHit } from "./types";

// Lexical half of hybrid retrieval: a MiniSearch full-text index over the
// same chunks the vector index holds. Catches the queries embeddings are
// weak at — exact names, IDs, rare tokens ("invoice_2024_final") — where
// surface-form match beats semantic similarity. Runs in the retrieval
// worker (wired in commit 13); pure and library-only here, so it is unit-
// testable on its own.

/** The fields MiniSearch tokenizes. We keep full chunk metadata in the
 *  worker's own map, so nothing is stored in the index beyond its id. */
export type LexicalDoc = {
  id: string;
  text: string;
  title: string;
  breadcrumbs: string;
};

// Title and breadcrumbs are short, high-signal fields — a query term in the
// doc title should outrank the same term buried in body text.
const FIELD_BOOST = { title: 3, breadcrumbs: 2, text: 1 };

export class LexicalIndex {
  private readonly engine = new MiniSearch<LexicalDoc>({
    fields: ["text", "title", "breadcrumbs"],
    storeFields: [],
    idField: "id",
    searchOptions: {
      // Typo tolerance (edit distance ≈ 20% of term length) and prefix
      // match so partial/as-you-type queries still hit.
      fuzzy: 0.2,
      prefix: true,
      boost: FIELD_BOOST,
    },
  });

  add(docs: LexicalDoc[]): void {
    this.engine.addAll(docs);
  }

  get size(): number {
    return this.engine.documentCount;
  }

  /** Removes documents by id (no-op for ids not present). */
  remove(ids: string[]): void {
    for (const id of ids) {
      if (this.engine.has(id)) this.engine.discard(id);
    }
  }

  search(query: string, k: number): SearchHit[] {
    if (!query.trim()) return [];
    return this.engine
      .search(query)
      .slice(0, k)
      .map((r) => ({ id: r.id as string, score: r.score }));
  }
}
