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

/** files.list projection — the metadata we keep for every doc. */
export type DocMeta = {
  id: string;
  name: string;
  /** RFC 3339 timestamp from Drive. */
  modifiedTime: string;
};

export type Request =
  | { type: "ping" }
  | { type: "auth.getStatus" }
  | { type: "auth.signIn" }
  | { type: "drive.listDocs" }
  | { type: "drive.exportAll" }
  | { type: "embed.test" };

/** Service worker → offscreen document. Runtime messages are broadcast to
 *  every extension context, so each message carries an explicit target. */
export type OffscreenRequest = {
  target: "offscreen";
  type: "embed";
  id: number;
  texts: string[];
};

export type OffscreenResponse =
  | {
      ok: true;
      dims: number;
      count: number;
      /** Row-major floats — plain array because runtime messaging is JSON. */
      vectors: number[];
      workerStartedAt: number;
      embedsServed: number;
      backend: string;
      modelLoadMs: number;
      inferMs: number;
    }
  | { ok: false; error: string };

export type Response =
  | { type: "pong"; startedAt: number }
  | { type: "auth.status"; status: AuthStatus }
  | { type: "drive.docList"; ok: true; count: number; sample: string[] }
  | { type: "drive.docList"; ok: false; error: string }
  | {
      type: "drive.exportReport";
      ok: true;
      exported: number;
      failed: number;
      totalChars: number;
      elapsedMs: number;
      /** First few failures for display; the full list is in the SW console. */
      failureSample: { name: string; error: string }[];
    }
  | { type: "drive.exportReport"; ok: false; error: string }
  | {
      type: "embed.testResult";
      ok: true;
      count: number;
      dims: number;
      swStartedAt: number;
      workerStartedAt: number;
      embedsServed: number;
      backend: string;
      modelLoadMs: number;
      textsPerSec: number;
    }
  | { type: "embed.testResult"; ok: false; error: string };

export function sendRequest(request: Request): Promise<Response> {
  return chrome.runtime.sendMessage({ ...request, target: "background" });
}
