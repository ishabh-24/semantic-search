// Typed request/response protocol for chrome.runtime messaging.
// Every message crossing a context boundary (popup ⇄ service worker,
// and later service worker ⇄ offscreen/embedder) is declared here, so
// each side type-checks against the same contract.

export type Request = { type: "ping" };

export type Response = {
  type: "pong";
  /** Epoch ms when the responding service worker instance started. */
  startedAt: number;
};

export function sendRequest(request: Request): Promise<Response> {
  return chrome.runtime.sendMessage(request);
}
