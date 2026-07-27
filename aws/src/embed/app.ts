// Stateless /embed handler for the opt-in cloud tier.
//
// Contract (implemented in commit 26): POST { texts: string[] } ->
// { vectors: number[][], dims: number, model: string }. It invokes Bedrock
// (BEDROCK_MODEL_ID), returns the vectors, and stores nothing — no
// persistence, no request-body logging.
//
// This commit (25) ships the infrastructure with a stub handler so the whole
// stack deploys and is reachable end to end.

type ApiEvent = { body: string | null };
type ApiResult = { statusCode: number; headers?: Record<string, string>; body: string };

export const handler = async (_event: ApiEvent): Promise<ApiResult> => {
  return {
    statusCode: 501,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: "embed handler not implemented yet (lands in commit 26)" }),
  };
};
