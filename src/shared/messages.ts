// Typed request/response protocol for chrome.runtime messaging.
// Every message crossing a context boundary (popup ⇄ service worker,
// and later service worker ⇄ offscreen/embedder) is declared here, so
// each side type-checks against the same contract.

export type AuthStatus =
  | { state: "connected"; email: string | null }
  | { state: "disconnected"; reason: DisconnectedReason; detail?: string };

export type DisconnectedReason =
  /** No grant exists yet — first-run state. */
  | "never_connected"
  /** A grant existed but Google reports the token invalid and Chrome
   *  cannot mint a fresh one: the user revoked access. */
  | "revoked"
  /** User closed or declined the consent window. */
  | "declined"
  /** No Google account is signed in to Chrome. */
  | "chrome_signed_out"
  /** Bad or placeholder OAuth client ID in the manifest. */
  | "config"
  | "error";

export type Request =
  | { type: "ping" }
  | { type: "auth.getStatus" }
  | { type: "auth.signIn" };

export type Response =
  | { type: "pong"; startedAt: number }
  | { type: "auth.status"; status: AuthStatus };

export function sendRequest(request: Request): Promise<Response> {
  return chrome.runtime.sendMessage(request);
}
