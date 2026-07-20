import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type {
  ChunkRecord,
  DocHit,
  WorkerRequest,
  WorkerResponse,
} from "../shared/worker-protocol";
import { VectorIndex } from "../retrieval/vector-index";
import { LexicalIndex } from "../retrieval/lexical-index";
import { reciprocalRankFusion } from "../retrieval/fusion";
import { planBatches, DEFAULT_BATCH_OPTIONS } from "../indexing/batching";

// Real embedder: all-MiniLM-L6-v2 via transformers.js on the ONNX WASM
// backend. Model weights are DATA and may come from the network (pinned
// revision, cached via the Cache API after first download); the WASM
// runtime is CODE and ships inside the extension package per MV3's
// remote-code ban (see build.mjs copy step + manifest CSP).

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
// Pinned HF revision (2025-07-22). Bump deliberately, never track main:
// an upstream re-upload must not silently change every vector we produce.
const MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const EXPECTED_DIMS = 384;

// Per-backend precision. WASM runs q8 (small, fast on CPU); WebGPU runs
// fp32 (full quality, broad GPU compatibility, still far faster than
// WASM). Same model either way — vectors differ only by rounding.
type Backend = "webgpu" | "wasm";
const DTYPE: Record<Backend, "q8" | "fp32"> = { webgpu: "fp32", wasm: "q8" };

const workerStartedAt = Date.now();
let embedsServed = 0;
let activeBackend: Backend = "wasm";

env.allowLocalModels = false;
env.useBrowserCache = true; // Cache API: cold load downloads once per profile

// ORT loads its .mjs/.wasm pair from here — bundled next to this worker's
// bundle in dist/, never from a CDN.
const wasmEnv = env.backends.onnx?.wasm;
if (!wasmEnv) throw new Error("onnx wasm backend env missing");
wasmEnv.wasmPaths = new URL("./", self.location.href).href;
if (!self.crossOriginIsolated) {
  // No SharedArrayBuffer without cross-origin isolation; force the
  // single-threaded WASM path rather than letting ORT warn and fall back.
  wasmEnv.numThreads = 1;
}

console.log(`[embedder] worker started at ${new Date(workerStartedAt).toISOString()}`);

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
let modelLoadMs = 0;

/** navigator.gpu is necessary but not sufficient — a working adapter must
 *  actually be obtainable (headless/blocklisted GPUs expose the API but
 *  return no adapter). */
async function webgpuAvailable(): Promise<boolean> {
  // Minimal structural type — avoids depending on @webgpu/types just to
  // null-check an adapter under the WebWorker lib.
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

function loadPipeline(backend: Backend): Promise<FeatureExtractionPipeline> {
  const t0 = Date.now();
  return pipeline("feature-extraction", MODEL_ID, {
    revision: MODEL_REVISION,
    device: backend,
    dtype: DTYPE[backend],
    progress_callback: (p: { status: string; file?: string; progress?: number }) => {
      if (p.status === "progress" && p.progress !== undefined) {
        console.log(`[embedder] downloading ${p.file}: ${Math.round(p.progress)}%`);
      }
    },
  }).then((extractor) => {
    activeBackend = backend;
    modelLoadMs = Date.now() - t0;
    console.log(`[embedder] model ready on ${backend} (${DTYPE[backend]}) in ${modelLoadMs}ms`);
    return extractor;
  });
}

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const useWebgpu = await webgpuAvailable();
      if (useWebgpu) {
        try {
          return await loadPipeline("webgpu");
        } catch (error) {
          // Adapter present but the pipeline still failed (driver quirk,
          // unsupported op). Fall back rather than leaving search broken.
          console.warn("[embedder] WebGPU load failed, falling back to WASM:", error);
        }
      }
      return loadPipeline("wasm");
    })();
    // A failed load (offline first run) must not poison the worker forever.
    extractorPromise.catch(() => {
      extractorPromise = null;
    });
  }
  return extractorPromise;
}

async function embed(
  texts: string[],
): Promise<{ vectors: Float32Array; dims: number; inferMs: number }> {
  const extractor = await getExtractor();
  // Mean pooling + L2 normalization → unit vectors, so cosine similarity
  // downstream is a plain dot product.
  const t0 = Date.now();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const inferMs = Date.now() - t0;
  const dims = output.dims.at(-1) ?? 0;
  if (dims !== EXPECTED_DIMS) {
    throw new Error(`unexpected embedding dims ${dims} (expected ${EXPECTED_DIMS})`);
  }
  // Copy out of the tensor before transferring: ORT may reuse its buffer.
  const vectors = Float32Array.from(output.data as Float32Array);
  output.dispose?.();
  return { vectors, dims, inferMs };
}

// ---- In-memory hybrid index (lives here so vectors never cross a boundary).

const vectorIndex = new VectorIndex(EXPECTED_DIMS);
const lexicalIndex = new LexicalIndex();
const metadata = new Map<string, ChunkRecord>();

/** Embeds a set of chunks (length-sorted batching to cut padding waste) and
 *  adds them to the vector index, lexical index, and metadata map. */
async function addChunks(chunks: ChunkRecord[]): Promise<number> {
  const texts = chunks.map((c) => c.text);
  for (const batch of planBatches(texts, DEFAULT_BATCH_OPTIONS)) {
    const { vectors } = await embed(batch.map((i) => texts[i]!));
    vectorIndex.addBatch(
      batch.map((i) => chunks[i]!.id),
      vectors,
    );
  }
  lexicalIndex.add(
    chunks.map((c) => ({
      id: c.id,
      text: c.text,
      title: c.docName,
      breadcrumbs: c.breadcrumbs.join(" › "),
    })),
  );
  for (const c of chunks) metadata.set(c.id, c);
  return vectorIndex.size;
}

function makeSnippet(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

async function search(query: string, k: number): Promise<DocHit[]> {
  if (!query.trim() || vectorIndex.size === 0) return [];
  const { vectors: queryVec } = await embed([query]);

  // Pull more candidates than k from each ranker so fusion has material to
  // work with before we collapse to one hit per document.
  const candidates = Math.max(k * 5, 50);
  const vecHits = vectorIndex.search(queryVec, candidates);
  const lexHits = lexicalIndex.search(query, candidates);

  const fused = reciprocalRankFusion([vecHits, lexHits], {
    recencyOf: (id) => {
      const m = metadata.get(id);
      return m ? Date.parse(m.modifiedTime) || 0 : 0;
    },
  });

  // Doc-level results: keep the highest-ranked chunk per document.
  const seenDocs = new Set<string>();
  const hits: DocHit[] = [];
  for (const hit of fused) {
    const m = metadata.get(hit.id);
    if (!m || seenDocs.has(m.docId)) continue;
    seenDocs.add(m.docId);
    hits.push({
      docId: m.docId,
      docName: m.docName,
      breadcrumbs: m.breadcrumbs,
      snippet: makeSnippet(m.text),
      score: hit.score,
      chunkId: m.id,
    });
    if (hits.length >= k) break;
  }
  return hits;
}

function reply(response: WorkerResponse, transfer: Transferable[] = []): void {
  postMessage(response, transfer);
}

self.addEventListener("message", async (event) => {
  const request = (event as MessageEvent).data as WorkerRequest;
  try {
    switch (request.type) {
      case "embed": {
        const { vectors, dims, inferMs } = await embed(request.texts);
        embedsServed++;
        reply(
          {
            id: request.id,
            ok: true,
            type: "embed",
            dims,
            vectors,
            workerStartedAt,
            embedsServed,
            backend: activeBackend,
            modelLoadMs,
            inferMs,
          },
          [vectors.buffer],
        );
        break;
      }
      case "index.add": {
        const indexSize = await addChunks(request.chunks);
        reply({ id: request.id, ok: true, type: "index.add", indexSize });
        break;
      }
      case "search": {
        const hits = await search(request.query, request.k);
        reply({ id: request.id, ok: true, type: "search", hits, indexSize: vectorIndex.size });
        break;
      }
      case "index.stats": {
        reply({
          id: request.id,
          ok: true,
          type: "index.stats",
          indexSize: vectorIndex.size,
          backend: activeBackend,
        });
        break;
      }
    }
  } catch (error) {
    reply({ id: request.id, ok: false, error: String(error) });
  }
});
