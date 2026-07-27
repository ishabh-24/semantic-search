import type { OffscreenRequest, OffscreenResponse } from "../shared/messages";
import type { WorkerRequest } from "../shared/worker-protocol";
import { getTierSettings } from "./tier-settings";

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

  // The doc (and its worker) is gone — the recreated worker boots with the
  // local-tier default, so the stored config must be pushed again.
  tierPushed = false;
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

// A fresh worker starts in the local-tier default, so the stored tier config
// must reach it before any embedding work. Pushed lazily before the first
// real request of each SW instance, and re-pushed after the offscreen doc
// (and with it the worker) is recreated. tier.set is idempotent worker-side:
// re-pushing the same settings never clears the index.
let tierPushed = false;

async function ensureTierPushed(): Promise<void> {
  if (tierPushed) return;
  tierPushed = true; // set before the call: callWorker below must not recurse
  try {
    const response = await callWorker({ type: "tier.set", settings: await getTierSettings() });
    if (!response.ok) throw new Error(`tier.set failed: ${response.error}`);
  } catch (error) {
    tierPushed = false;
    throw error;
  }
}

// Plain Omit over a union keeps only common keys (dropping texts/chunks/…);
// distribute it across the union so each variant keeps its own fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Sends one request to the worker and awaits its single response. The `id`
 *  is assigned here; callers pass everything else. */
export async function callWorker(
  request: DistributiveOmit<WorkerRequest, "id">,
): Promise<OffscreenResponse> {
  await ensureOffscreenDocument();
  if (request.type !== "tier.set") await ensureTierPushed();
  const full = { ...request, id: nextRequestId++ } as WorkerRequest;
  const response = (await chrome.runtime.sendMessage({
    target: "offscreen",
    request: full,
  } satisfies OffscreenRequest)) as OffscreenResponse | undefined;
  if (!response) throw new Error("no response from offscreen document");
  return response;
}
