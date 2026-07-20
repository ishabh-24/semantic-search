import type { OffscreenRequest, OffscreenResponse } from "../shared/messages";
import type { WorkerResponse } from "../shared/worker-protocol";

// Offscreen document: exists solely to host the retrieval worker with a
// lifetime independent of the MV3 service worker, and to relay messages
// between chrome.runtime (SW side) and postMessage (worker side). It is a
// dumb pipe — no retrieval logic lives here.

console.log(`[offscreen] document started at ${new Date().toISOString()}`);

const worker = new Worker("embedder-worker.js", { type: "module" });
const pending = new Map<number, (response: OffscreenResponse) => void>();

// Runtime messaging is JSON, so the transferable Float32Array from an embed
// response can't survive the SW hop — convert it to a plain array here.
function toJsonSafe(response: WorkerResponse): OffscreenResponse {
  if (response.ok && response.type === "embed") {
    return { ...response, vectors: Array.from(response.vectors) };
  }
  // Every non-embed variant is structurally identical across the two types
  // (the embed vectors — the only real difference — are handled above).
  // Cast via unknown so the Float32Array-vs-number[] field can't trip TS's
  // "insufficient overlap" check on this union-to-union assertion.
  return response as unknown as OffscreenResponse;
}

worker.addEventListener("message", (event) => {
  const response = event.data as WorkerResponse;
  const resolve = pending.get(response.id);
  if (!resolve) return;
  pending.delete(response.id);
  resolve(toJsonSafe(response));
});

worker.addEventListener("error", (event) => {
  console.error("[offscreen] worker error", event.message);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Runtime messages are broadcast to every extension context; only act on
  // ones addressed to us.
  if ((message as { target?: string }).target !== "offscreen") return false;
  const { request } = message as OffscreenRequest;
  pending.set(request.id, sendResponse);
  worker.postMessage(request);
  return true; // keep the channel open for the async response
});
