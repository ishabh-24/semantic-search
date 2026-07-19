import type { OffscreenRequest, OffscreenResponse } from "../shared/messages";
import type { WorkerRequest, WorkerResponse } from "../shared/worker-protocol";

// Offscreen document: exists solely to host the embedder worker with a
// lifetime independent of the MV3 service worker, and to route messages
// between chrome.runtime (SW side) and postMessage (worker side).

console.log(`[offscreen] document started at ${new Date().toISOString()}`);

const worker = new Worker("embedder-worker.js", { type: "module" });

const pending = new Map<number, (response: WorkerResponse) => void>();

worker.addEventListener("message", (event) => {
  const response = event.data as WorkerResponse;
  const resolve = pending.get(response.id);
  pending.delete(response.id);
  resolve?.(response);
});

worker.addEventListener("error", (event) => {
  console.error("[offscreen] worker error", event.message);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Runtime messages are broadcast to every extension context; only act
  // on ones addressed to us.
  if ((message as { target?: string }).target !== "offscreen") return false;
  const request = message as OffscreenRequest;

  pending.set(request.id, (response) => {
    const reply: OffscreenResponse = response.ok
      ? {
          ok: true,
          dims: response.dims,
          count: request.texts.length,
          // Runtime messaging JSON-serializes; typed arrays don't survive.
          vectors: Array.from(response.vectors),
          workerStartedAt: response.workerStartedAt,
          embedsServed: response.embedsServed,
        }
      : { ok: false, error: response.error };
    sendResponse(reply);
  });

  worker.postMessage({
    id: request.id,
    type: "embed",
    texts: request.texts,
  } satisfies WorkerRequest);
  return true; // keep the channel open for the async response
});
