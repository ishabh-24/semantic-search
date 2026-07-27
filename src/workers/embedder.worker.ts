import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type {
  ChunkRecord,
  DocHit,
  WorkerRequest,
  WorkerResponse,
} from "../shared/worker-protocol";
import { VectorIndex } from "../retrieval/vector-index";
import { LexicalIndex, type LexicalDoc } from "../retrieval/lexical-index";
import { reciprocalRankFusion } from "../retrieval/fusion";
import { planBatches, DEFAULT_BATCH_OPTIONS } from "../indexing/batching";
import { diffChunks } from "../indexing/chunk-diff";
import {
  serializeIndex,
  deserializeIndex,
  IndexFormatError,
  type IndexSnapshot,
} from "../persistence/index-format";
import { mergeSnapshots } from "../persistence/merge";
import { findIndexFile, uploadIndex, downloadIndex } from "../persistence/drive-appdata";
import {
  LOCAL_SPACE,
  parseCloudResponse,
  spaceFor,
  type TierSettings,
} from "../shared/embedding-tier";

// Local embedder: all-MiniLM-L6-v2 via transformers.js on the ONNX WASM
// backend. Model weights are DATA and may come from the network (pinned
// revision, cached via the Cache API after first download); the WASM
// runtime is CODE and ships inside the extension package per MV3's
// remote-code ban (see build.mjs copy step + manifest CSP).
//
// Tier routing: embed() dispatches per request to the local pipeline or the
// opt-in cloud /embed endpoint, per the tier config the SW pushes via
// tier.set. The two produce vectors in different embedding spaces
// (MiniLM-384 vs Titan-1024), so the active space also parameterizes the
// index, the snapshot stamp, and the load/merge compat checks — a tier
// switch across spaces wipes the index rather than ever mixing them.

// The SW pushes tier config before any embedding work (offscreen-client
// re-pushes on worker restart), so the default only covers the gap until
// that first push — and matches the SW-side default of fully-local.
let tierSettings: TierSettings = { tier: "local" };
let space = LOCAL_SPACE;

// Per-backend precision. WASM runs q8 (small, fast on CPU); WebGPU runs
// fp32 (full quality, broad GPU compatibility, still far faster than
// WASM). Same model either way — vectors differ only by rounding.
type Backend = "webgpu" | "wasm";
const DTYPE: Record<Backend, "q8" | "fp32"> = { webgpu: "fp32", wasm: "q8" };

const workerStartedAt = Date.now();
let embedsServed = 0;
let activeBackend: Backend | "cloud" = "wasm";

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
  return pipeline("feature-extraction", LOCAL_SPACE.modelId, {
    revision: LOCAL_SPACE.revision,
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

/** Per-request tier router: every embedding in this worker flows through
 *  here, so query vectors and index vectors always come from the same tier. */
async function embed(
  texts: string[],
): Promise<{ vectors: Float32Array; dims: number; inferMs: number }> {
  return tierSettings.tier === "cloud" ? cloudEmbed(texts, tierSettings) : localEmbed(texts);
}

async function localEmbed(
  texts: string[],
): Promise<{ vectors: Float32Array; dims: number; inferMs: number }> {
  const extractor = await getExtractor();
  // Mean pooling + L2 normalization → unit vectors, so cosine similarity
  // downstream is a plain dot product.
  const t0 = Date.now();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const inferMs = Date.now() - t0;
  const dims = output.dims.at(-1) ?? 0;
  if (dims !== LOCAL_SPACE.dims) {
    throw new Error(`unexpected embedding dims ${dims} (expected ${LOCAL_SPACE.dims})`);
  }
  // Copy out of the tensor before transferring: ORT may reuse its buffer.
  const vectors = Float32Array.from(output.data as Float32Array);
  output.dispose?.();
  return { vectors, dims, inferMs };
}

// The endpoint accepts up to 64 texts per request, but Bedrock invokes one
// text per call and fresh-account quotas run as low as ~1 call/sec — a big
// request would blow the Lambda's timeout while it paces itself. Small
// requests keep each round-trip comfortably inside it.
const CLOUD_MAX_TEXTS = 12;
// Generous retries: indexing is a background job, so waiting out a
// throttled minute beats failing the doc.
const CLOUD_RETRIES = 5;

async function cloudEmbed(
  texts: string[],
  settings: Extract<TierSettings, { tier: "cloud" }>,
): Promise<{ vectors: Float32Array; dims: number; inferMs: number }> {
  const t0 = Date.now();
  const out = new Float32Array(texts.length * space.dims);
  for (let start = 0; start < texts.length; start += CLOUD_MAX_TEXTS) {
    const slice = texts.slice(start, start + CLOUD_MAX_TEXTS);
    const vectors = await cloudEmbedOnce(slice, settings);
    out.set(vectors, start * space.dims);
  }
  activeBackend = "cloud";
  return { vectors: out, dims: space.dims, inferMs: Date.now() - t0 };
}

async function cloudEmbedOnce(
  texts: string[],
  settings: Extract<TierSettings, { tier: "cloud" }>,
): Promise<Float32Array> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(settings.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": settings.apiKey },
      body: JSON.stringify({ texts }),
    });
    // Throttling (429, from the usage plan or Bedrock's own quota) is
    // expected under indexing load — back off and retry before surfacing.
    if (response.status === 429 && attempt < CLOUD_RETRIES) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (!response.ok) {
      throw new Error(`cloud embed failed: HTTP ${response.status} ${await response.text()}`);
    }
    // Model/dims guard: a response from the wrong model or shape throws here,
    // before any vector can reach the index.
    return parseCloudResponse(await response.json(), space, texts.length);
  }
}

// ---- In-memory hybrid index (lives here so vectors never cross a boundary).

let vectorIndex = new VectorIndex(space.dims);
let lexicalIndex = new LexicalIndex();
const metadata = new Map<string, ChunkRecord>();

/** Applies a tier change. Crossing embedding spaces with a populated index
 *  wipes it — MiniLM and Titan vectors must never share an index — and the
 *  caller is told so it can trigger a full re-embed. Same-space changes
 *  (e.g. updating the cloud API key) keep the index untouched. */
function setTier(settings: TierSettings): { cleared: boolean; indexSize: number } {
  const nextSpace = spaceFor(settings);
  const crossed = nextSpace.modelId !== space.modelId;
  const cleared = crossed && vectorIndex.size > 0;
  if (crossed) {
    vectorIndex = new VectorIndex(nextSpace.dims);
    lexicalIndex = new LexicalIndex();
    metadata.clear();
    // Whatever Drive blob we were tracking is in the old space now.
    loadedRevisionId = null;
  }
  tierSettings = settings;
  space = nextSpace;
  console.log(
    `[worker] tier set to ${settings.tier} (${space.modelId}, ${space.dims}d)` +
      (cleared ? " — index cleared, re-embed required" : ""),
  );
  return { cleared, indexSize: vectorIndex.size };
}

function lexicalDoc(c: ChunkRecord): LexicalDoc {
  return { id: c.id, text: c.text, title: c.docName, breadcrumbs: c.breadcrumbs.join(" › ") };
}

function docCount(): number {
  const docs = new Set<string>();
  for (const c of metadata.values()) docs.add(c.docId);
  return docs.size;
}

/** Removes every chunk belonging to the given documents from all three
 *  structures. Used for deletions and to replace a modified doc's old chunks
 *  before its new ones are added. */
async function removeDocs(docIds: string[]): Promise<number> {
  const targets = new Set(docIds);
  const chunkIds: string[] = [];
  for (const [id, record] of metadata) {
    if (targets.has(record.docId)) chunkIds.push(id);
  }
  if (chunkIds.length === 0) return vectorIndex.size;
  vectorIndex.remove(new Set(chunkIds));
  await lexicalIndex.remove(chunkIds);
  for (const id of chunkIds) metadata.delete(id);
  return vectorIndex.size;
}

/** Re-indexes a modified (or new) document, re-embedding only the chunks whose
 *  text changed and reusing existing vectors for unchanged chunks. */
async function updateChunks(chunks: ChunkRecord[]): Promise<{
  indexSize: number;
  embedded: number;
  reused: number;
}> {
  const byDoc = new Map<string, ChunkRecord[]>();
  for (const c of chunks) {
    const group = byDoc.get(c.docId);
    if (group) group.push(c);
    else byDoc.set(c.docId, [c]);
  }

  let embedded = 0;
  let reused = 0;
  for (const [docId, newChunks] of byDoc) {
    // This doc's current chunk vectors, keyed by their text.
    const existingByText = new Map<string, Float32Array>();
    for (const [id, record] of metadata) {
      if (record.docId !== docId) continue;
      const vector = vectorIndex.get(id);
      if (vector) existingByText.set(record.text, vector);
    }

    const plan = diffChunks(
      newChunks.map((c) => c.text),
      existingByText,
    );

    // Embed only the chunks with no reusable vector (length-sorted batches).
    const embedPositions = plan.reuse.flatMap((v, i) => (v ? [] : [i]));
    const embedTexts = embedPositions.map((i) => newChunks[i]!.text);
    const fresh = new Float32Array(embedTexts.length * space.dims);
    for (const batch of planBatches(embedTexts, DEFAULT_BATCH_OPTIONS)) {
      const { vectors } = await embed(batch.map((i) => embedTexts[i]!));
      batch.forEach((origIdx, j) => {
        fresh.set(vectors.subarray(j * space.dims, (j + 1) * space.dims), origIdx * space.dims);
      });
    }

    // Replace the doc's chunks: reused vectors kept, fresh ones embedded above.
    await removeDocs([docId]);
    let freshRow = 0;
    for (let i = 0; i < newChunks.length; i++) {
      let vector = plan.reuse[i];
      if (!vector) {
        vector = fresh.subarray(freshRow * space.dims, (freshRow + 1) * space.dims);
        freshRow++;
      }
      vectorIndex.add(newChunks[i]!.id, vector);
    }
    lexicalIndex.add(newChunks.map(lexicalDoc));
    for (const c of newChunks) metadata.set(c.id, c);

    embedded += embedTexts.length;
    reused += plan.reuseCount;
    console.log(`[worker] doc ${docId}: embedded ${embedTexts.length}, reused ${plan.reuseCount} chunks`);
  }
  return { indexSize: vectorIndex.size, embedded, reused };
}

/** Embeds a set of chunks (length-sorted batching to cut padding waste) and
 *  adds them to the vector index, lexical index, and metadata map.
 *  Idempotent: chunk ids already present are skipped, so a resumed job that
 *  replays a partially-indexed doc can't double-add (MiniSearch also rejects
 *  duplicate ids). */
async function addChunks(chunks: ChunkRecord[]): Promise<number> {
  const fresh = chunks.filter((c) => !metadata.has(c.id));
  if (fresh.length === 0) return vectorIndex.size;

  const texts = fresh.map((c) => c.text);
  for (const batch of planBatches(texts, DEFAULT_BATCH_OPTIONS)) {
    const { vectors } = await embed(batch.map((i) => texts[i]!));
    vectorIndex.addBatch(
      batch.map((i) => fresh[i]!.id),
      vectors,
    );
  }
  lexicalIndex.add(fresh.map(lexicalDoc));
  for (const c of fresh) metadata.set(c.id, c);
  return vectorIndex.size;
}

// headRevisionId of the Drive blob this worker last loaded or wrote. Used to
// detect a concurrent write from another device before we overwrite it. Null
// means we've never reconciled with Drive, so any existing remote counts as a
// divergence to be merged (not clobbered).
let loadedRevisionId: string | null = null;

function buildSnapshot(): IndexSnapshot {
  const { ids, vectors } = vectorIndex.snapshot();
  return {
    modelId: space.modelId,
    revision: space.revision,
    dims: space.dims,
    vectors,
    chunks: ids.map((id) => metadata.get(id)!),
  };
}

/** Replaces the live index with a snapshot — no re-embedding. */
function populateFromSnapshot(snapshot: IndexSnapshot): void {
  vectorIndex = new VectorIndex(space.dims);
  lexicalIndex = new LexicalIndex();
  metadata.clear();
  vectorIndex.addBatch(
    snapshot.chunks.map((c) => c.id),
    snapshot.vectors,
  );
  lexicalIndex.add(snapshot.chunks.map(lexicalDoc));
  for (const c of snapshot.chunks) metadata.set(c.id, c);
}

/** Deserializes a remote blob for merging, or null if it's unusable (corrupt
 *  or a different embedding model — we won't fold incompatible vectors in). */
async function readRemote(buffer: ArrayBuffer): Promise<IndexSnapshot | null> {
  try {
    const snapshot = await deserializeIndex(buffer);
    if (snapshot.modelId !== space.modelId || snapshot.revision !== space.revision) return null;
    return snapshot;
  } catch (error) {
    if (error instanceof IndexFormatError) return null;
    throw error;
  }
}

/** Serializes the live index and writes it to Drive appDataFolder. If another
 *  device wrote since we last synced (headRevisionId changed), downloads and
 *  merges its index first (union of docs, last-write-wins per doc) so no
 *  device's work is lost, then re-checks and retries until our write is the
 *  latest. Vectors never leave the worker. */
async function saveIndex(token: string): Promise<{ fileId: string; sizeBytes: number }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await findIndexFile(token);

    if (remote && remote.headRevisionId !== loadedRevisionId) {
      const remoteSnapshot = await readRemote(await downloadIndex(token, remote.id));
      if (remoteSnapshot) {
        const before = vectorIndex.size;
        populateFromSnapshot(mergeSnapshots(buildSnapshot(), remoteSnapshot));
        console.log(
          `[worker] merged concurrent write from another device: ` +
            `${before} local + ${remoteSnapshot.chunks.length} remote chunks → ${vectorIndex.size} union`,
        );
      }
      loadedRevisionId = remote.headRevisionId; // we've now incorporated it
    }

    const buffer = await serializeIndex(buildSnapshot());
    const written = await uploadIndex(token, remote?.id ?? null, buffer);

    // Confirm nothing landed between our merge and our write; if it did, loop
    // to fold that change in too.
    const after = await findIndexFile(token);
    if (after && after.headRevisionId === written.headRevisionId) {
      loadedRevisionId = written.headRevisionId;
      return { fileId: written.id, sizeBytes: buffer.byteLength };
    }
  }
  throw new Error("index save kept losing a write race after several retries");
}

/** Restores the index from Drive with zero re-embedding. Returns loaded:false
 *  (not an error) when there's nothing to restore or the blob is unusable —
 *  network failures still throw so the caller can distinguish them. */
async function loadIndex(
  token: string,
): Promise<{ loaded: boolean; indexSize: number; docCount: number; reason?: string }> {
  const ref = await findIndexFile(token);
  if (!ref) return { loaded: false, indexSize: 0, docCount: 0, reason: "no saved index" };

  const snapshot = await readRemote(await downloadIndex(token, ref.id));
  if (!snapshot) {
    return { loaded: false, indexSize: 0, docCount: 0, reason: "saved index is corrupt or from a different model" };
  }

  populateFromSnapshot(snapshot);
  loadedRevisionId = ref.headRevisionId;
  return { loaded: true, indexSize: vectorIndex.size, docCount: docCount() };
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
      case "tier.set": {
        const { cleared, indexSize } = setTier(request.settings);
        reply({ id: request.id, ok: true, type: "tier.set", cleared, indexSize });
        break;
      }
      case "index.add": {
        const indexSize = await addChunks(request.chunks);
        reply({ id: request.id, ok: true, type: "index.add", indexSize });
        break;
      }
      case "index.remove": {
        const indexSize = await removeDocs(request.docIds);
        reply({ id: request.id, ok: true, type: "index.remove", indexSize });
        break;
      }
      case "index.update": {
        const { indexSize, embedded, reused } = await updateChunks(request.chunks);
        reply({ id: request.id, ok: true, type: "index.update", indexSize, embedded, reused });
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
          docCount: docCount(),
          backend: activeBackend,
          workerStartedAt,
        });
        break;
      }
      case "index.save": {
        const { fileId, sizeBytes } = await saveIndex(request.token);
        reply({ id: request.id, ok: true, type: "index.save", fileId, sizeBytes });
        break;
      }
      case "index.load": {
        const result = await loadIndex(request.token);
        reply({ id: request.id, ok: true, type: "index.load", ...result });
        break;
      }
    }
  } catch (error) {
    reply({ id: request.id, ok: false, error: String(error) });
  }
});
