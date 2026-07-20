import type { OffscreenRequest, OffscreenResponse } from "../shared/messages";
import type { WorkerRequest } from "../shared/worker-protocol";

// SW-side gateway to the offscreen-hosted retrieval worker. Strategy is
// recovery, not prevention: before every call we ensure the offscreen
// document exists and recreate it if Chrome closed it — worst case is a
// warm-up, never an error. (Recreation also empties the in-memory index;
// durable persistence lands in commit 16.)

const OFFSCREEN_URL = "offscreen.html";

// Chrome allows exactly one offscreen document; concurrent createDocument
// calls throw. The in-flight promise is the creation lock.
let creating: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification:
          "Hosts the on-device embedding model and search index in a Web " +
          "Worker so they stay warm across service worker restarts and never " +
          "block a UI thread.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

let nextRequestId = 1;

// Plain Omit over a union keeps only common keys (dropping texts/chunks/…);
// distribute it across the union so each variant keeps its own fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Sends one request to the worker and awaits its single response. The `id`
 *  is assigned here; callers pass everything else. */
export async function callWorker(
  request: DistributiveOmit<WorkerRequest, "id">,
): Promise<OffscreenResponse> {
  await ensureOffscreenDocument();
  const full = { ...request, id: nextRequestId++ } as WorkerRequest;
  const response = (await chrome.runtime.sendMessage({
    target: "offscreen",
    request: full,
  } satisfies OffscreenRequest)) as OffscreenResponse | undefined;
  if (!response) throw new Error("no response from offscreen document");
  return response;
}
