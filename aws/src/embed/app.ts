// Stateless /embed handler for the opt-in cloud tier.
//
// POST { texts: string[] } -> { vectors: number[][], dims: number, model: string }
//
// Invokes the Bedrock embedding model (BEDROCK_MODEL_ID) once per text with a
// small concurrency cap and returns unit-normalized vectors, matching the
// local embedder's contract (normalized vectors + dims). Stores nothing and
// never logs request text — logs carry only counts, durations, and error
// class names.

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "amazon.titan-embed-text-v2:0";
// Titan V2 supports 256/512/1024; the extension guards against mixing
// embedding spaces via the dims+model stamp in the index envelope.
const DIMS = 1024;
const MAX_TEXTS = 64;
const MAX_TEXT_CHARS = 8000;
// Bedrock quotas on fresh accounts are tight (60 req/min for Titan V2, one
// text per InvokeModel). Low concurrency plus the SDK's adaptive retry mode
// (client-side token bucket that learns the sustainable rate from throttle
// responses) turns a stampede-then-fail into a paced trickle that succeeds.
const CONCURRENCY = 2;

const client = new BedrockRuntimeClient({ retryMode: "adaptive", maxAttempts: 10 });

type ApiEvent = { body: string | null; isBase64Encoded?: boolean };
type ApiResult = { statusCode: number; headers?: Record<string, string>; body: string };

const json = (statusCode: number, payload: unknown): ApiResult => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

async function embedOne(text: string): Promise<number[]> {
  const res = await client.send(
    new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text, dimensions: DIMS, normalize: true }),
    }),
  );
  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] };
  return parsed.embedding;
}

export const handler = async (event: ApiEvent): Promise<ApiResult> => {
  const started = Date.now();

  let texts: unknown;
  try {
    const raw =
      event.isBase64Encoded && event.body
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
    if (raw == null) throw new Error("empty body");
    texts = (JSON.parse(raw) as { texts?: unknown }).texts;
  } catch {
    return json(400, { error: "body must be JSON: { texts: string[] }" });
  }

  if (
    !Array.isArray(texts) ||
    texts.length === 0 ||
    texts.length > MAX_TEXTS ||
    !texts.every((t) => typeof t === "string" && t.length > 0 && t.length <= MAX_TEXT_CHARS)
  ) {
    return json(400, {
      error: `texts must be 1-${MAX_TEXTS} non-empty strings of at most ${MAX_TEXT_CHARS} chars`,
    });
  }

  const items = texts as string[];
  const vectors: number[][] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      vectors[i] = await embedOne(items[i]);
    }
  });

  try {
    await Promise.all(workers);
  } catch (err) {
    const name = err instanceof Error && err.name ? err.name : "unknown";
    console.error(JSON.stringify({ event: "embed_error", name }));
    if (name === "ThrottlingException") {
      return json(429, { error: "throttled by embedding backend, retry with backoff" });
    }
    return json(502, { error: `embedding backend error: ${name}` });
  }

  console.log(JSON.stringify({ event: "embed_ok", texts: items.length, ms: Date.now() - started }));
  return json(200, { vectors, dims: DIMS, model: MODEL_ID });
};
