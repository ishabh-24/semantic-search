import { pipeline } from "@huggingface/transformers";
import { chunkDoc } from "../src/indexing/chunker";
import { VectorIndex } from "../src/retrieval/vector-index";
import { LexicalIndex } from "../src/retrieval/lexical-index";
import { reciprocalRankFusion } from "../src/retrieval/fusion";
import type { SearchHit } from "../src/retrieval/types";
import { DOCS, QUERIES } from "./corpus";
import { recallAtK, reciprocalRank, mean, formatTable, type ModeScore } from "./metrics";

// Runs the real retrieval pipeline over the labeled fixture corpus and reports
// recall@5 + MRR for lexical-only, semantic-only, and hybrid retrieval. Uses
// the same MiniLM config the extension ships, so the numbers reflect the
// actual system. One script; `npm run eval`.

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const DIMS = 384;
const CANDIDATES = 20; // chunk hits pulled per mode before collapsing to docs

// Chunk every doc; keep a chunkId → docId map for collapsing hits to docs.
const chunkToDoc = new Map<string, string>();
const chunkTexts: string[] = [];
const chunkIds: string[] = [];
const lexical = new LexicalIndex();

for (const doc of DOCS) {
  const chunks = chunkDoc(doc, doc.text);
  lexical.add(
    chunks.map((c) => ({
      id: c.id,
      text: c.text,
      title: doc.name,
      breadcrumbs: c.breadcrumbs.join(" › "),
    })),
  );
  for (const c of chunks) {
    chunkToDoc.set(c.id, doc.id);
    chunkIds.push(c.id);
    chunkTexts.push(c.text);
  }
}

console.log(`Embedding ${chunkTexts.length} chunks from ${DOCS.length} docs and ${QUERIES.length} queries…`);
const extractor = await pipeline("feature-extraction", MODEL_ID, {
  revision: MODEL_REVISION,
  dtype: "q8",
});

async function embed(texts: string[]): Promise<Float32Array[]> {
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  const flat = out.data as Float32Array;
  return texts.map((_, i) => flat.slice(i * DIMS, (i + 1) * DIMS));
}

const chunkVectors = await embed(chunkTexts);
const vectors = new VectorIndex(DIMS);
chunkVectors.forEach((v, i) => vectors.add(chunkIds[i]!, v));

const queryVectors = await embed(QUERIES.map((q) => q.q));

/** Collapse chunk-level hits to a doc-level ranking (best chunk per doc). */
function toDocRanking(hits: SearchHit[]): string[] {
  const seen = new Set<string>();
  const docs: string[] = [];
  for (const hit of hits) {
    const docId = chunkToDoc.get(hit.id);
    if (!docId || seen.has(docId)) continue;
    seen.add(docId);
    docs.push(docId);
  }
  return docs;
}

const modes = ["lexical", "semantic", "hybrid"] as const;
const r1: Record<string, number[]> = { lexical: [], semantic: [], hybrid: [] };
const r5: Record<string, number[]> = { lexical: [], semantic: [], hybrid: [] };
const rr: Record<string, number[]> = { lexical: [], semantic: [], hybrid: [] };

QUERIES.forEach((query, i) => {
  const lexHits = lexical.search(query.q, CANDIDATES);
  const vecHits = vectors.search(queryVectors[i]!, CANDIDATES);
  const rankings: Record<string, string[]> = {
    lexical: toDocRanking(lexHits),
    semantic: toDocRanking(vecHits),
    hybrid: toDocRanking(reciprocalRankFusion([vecHits, lexHits])),
  };
  const relevant = new Set(query.relevant);
  for (const mode of modes) {
    r1[mode]!.push(recallAtK(rankings[mode]!, relevant, 1));
    r5[mode]!.push(recallAtK(rankings[mode]!, relevant, 5));
    rr[mode]!.push(reciprocalRank(rankings[mode]!, relevant));
  }
});

const scores: ModeScore[] = modes.map((mode) => ({
  mode,
  recallAt1: mean(r1[mode]!),
  recallAt5: mean(r5[mode]!),
  mrr: mean(rr[mode]!),
}));

console.log(`\n${QUERIES.length} queries over ${DOCS.length} docs\n`);
console.log(formatTable(scores));

const hybrid = scores.find((s) => s.mode === "hybrid")!;
const singles = scores.filter((s) => s.mode !== "hybrid");
const best = (pick: (s: ModeScore) => number) => Math.max(...singles.map(pick));
const wins =
  hybrid.recallAt1 >= best((s) => s.recallAt1) - 1e-9 &&
  hybrid.recallAt5 >= best((s) => s.recallAt5) - 1e-9 &&
  hybrid.mrr >= best((s) => s.mrr) - 1e-9;
console.log(
  `\n${wins ? "✓" : "✗"} hybrid ${wins ? "matches or beats" : "does NOT beat"} both single modes ` +
    `on recall@1, recall@5, and MRR.`,
);
