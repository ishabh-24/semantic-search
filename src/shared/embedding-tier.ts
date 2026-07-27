// Embedding tiers: fully-local MiniLM (the default and the project's thesis)
// vs. the opt-in cloud endpoint (higher quality, still stateless server-side).
// Chrome-free so the worker, SW, and popup tsconfigs can all import it.

/** User-chosen embedding tier. Cloud carries the endpoint + API key the user
 *  pasted from their own deployed stack (see aws/README.md) — no credential
 *  ever ships inside the extension bundle. */
export type TierSettings =
  | { tier: "local" }
  | { tier: "cloud"; endpoint: string; apiKey: string };

/** An embedding space: vectors are comparable only within one. modelId +
 *  revision + dims stamp every index snapshot; mixing spaces in one index
 *  would make cosine scores meaningless, so all guards key off this. */
export type EmbeddingSpace = {
  modelId: string;
  revision: string;
  dims: number;
};

export const LOCAL_SPACE: EmbeddingSpace = {
  modelId: "Xenova/all-MiniLM-L6-v2",
  // Pinned HF revision (2025-07-22). Bump deliberately, never track main:
  // an upstream re-upload must not silently change every vector we produce.
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dims: 384,
};

export const CLOUD_SPACE: EmbeddingSpace = {
  modelId: "amazon.titan-embed-text-v2:0",
  // Bedrock model ids carry their version (":0"); the revision field just
  // needs to be stable and distinct from any local revision.
  revision: "bedrock",
  dims: 1024,
};

export function spaceFor(settings: TierSettings): EmbeddingSpace {
  return settings.tier === "cloud" ? CLOUD_SPACE : LOCAL_SPACE;
}

/** The /embed endpoint's response contract (see aws/README.md). */
type CloudResponse = { vectors: number[][]; dims: number; model: string };

/** Validates a cloud /embed response against the expected space and count,
 *  and flattens it to the row-major Float32Array the index uses. Throws on
 *  any mismatch — a wrong-model or wrong-dims vector must never reach an
 *  index built for a different space. */
export function parseCloudResponse(
  payload: unknown,
  space: EmbeddingSpace,
  expectedCount: number,
): Float32Array {
  const r = payload as Partial<CloudResponse> | null;
  if (!r || !Array.isArray(r.vectors) || typeof r.dims !== "number" || typeof r.model !== "string") {
    throw new Error("cloud embed response is not { vectors, dims, model }");
  }
  if (r.model !== space.modelId) {
    throw new Error(`cloud embed model mismatch: got ${r.model}, expected ${space.modelId}`);
  }
  if (r.dims !== space.dims) {
    throw new Error(`cloud embed dims mismatch: got ${r.dims}, expected ${space.dims}`);
  }
  if (r.vectors.length !== expectedCount) {
    throw new Error(`cloud embed returned ${r.vectors.length} vectors for ${expectedCount} texts`);
  }
  const out = new Float32Array(expectedCount * space.dims);
  for (let i = 0; i < r.vectors.length; i++) {
    const v = r.vectors[i]!;
    if (!Array.isArray(v) || v.length !== space.dims) {
      throw new Error(`cloud embed vector ${i} has ${v?.length ?? 0} dims, expected ${space.dims}`);
    }
    out.set(v, i * space.dims);
  }
  return out;
}
