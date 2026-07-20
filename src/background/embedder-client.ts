import type { OffscreenRequest, OffscreenResponse } from "../shared/messages";

// SW-side client for the offscreen embedder. Strategy is recovery, not
// prevention: before every call we check the offscreen document exists and
// recreate it if Chrome closed it — worst case is a warm-up, never an error.

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
          "Hosts the on-device embedding model in a Web Worker so it stays " +
          "warm across service worker restarts and never blocks a UI thread.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

export type EmbedResult = {
  /** Row-major [count × dims]. */
  vectors: Float32Array;
  dims: number;
  count: number;
  workerStartedAt: number;
  embedsServed: number;
  backend: string;
  modelLoadMs: number;
  inferMs: number;
};

let nextRequestId = 1;

export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  await ensureOffscreenDocument();
  const request: OffscreenRequest = {
    target: "offscreen",
    type: "embed",
    id: nextRequestId++,
    texts,
  };
  const response = (await chrome.runtime.sendMessage(request)) as OffscreenResponse | undefined;
  if (!response) throw new Error("no response from offscreen document");
  if (!response.ok) throw new Error(`embed failed: ${response.error}`);
  return {
    vectors: Float32Array.from(response.vectors),
    dims: response.dims,
    count: response.count,
    workerStartedAt: response.workerStartedAt,
    embedsServed: response.embedsServed,
    backend: response.backend,
    modelLoadMs: response.modelLoadMs,
    inferMs: response.inferMs,
  };
}
