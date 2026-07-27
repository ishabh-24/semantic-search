// Typed request/response protocol for chrome.runtime messaging.
// Every message crossing a context boundary (popup ⇄ service worker,
// and later service worker ⇄ offscreen/embedder) is declared here, so
// each side type-checks against the same contract.

import type { WorkerRequest, DocHit } from "./worker-protocol";
import type { TierSettings } from "./embedding-tier";

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

/** Snapshot of the background indexing job, shown in the popup. */
export type IndexProgress = {
  status: "idle" | "running" | "paused" | "done" | "error";
  doneDocs: number;
  totalDocs: number;
  doneChunks: number;
  /** Documents that couldn't be exported/indexed after retries (rate limits,
   *  offline, oversized). Surfaced so a partial index isn't mistaken for a
   *  complete one; a re-index retries them. */
  failedDocs: number;
  /** Active embedding backend, or "" before the job has started. */
  backend: string;
  /** Estimated seconds remaining, or null when not yet estimable. */
  etaSeconds: number | null;
  error?: string;
};

export type Request =
  | { type: "ping" }
  | { type: "auth.getStatus" }
  | { type: "auth.signIn" }
  | { type: "drive.listDocs" }
  | { type: "drive.exportAll" }
  | { type: "embed.test" }
  | { type: "embed.bench" }
  | { type: "index.start" }
  | { type: "index.pause" }
  | { type: "index.resume" }
  | { type: "index.status" }
  | { type: "sync.now" }
  | { type: "search"; query: string }
  | { type: "tier.get" }
  | { type: "tier.set"; settings: TierSettings };

/** Service worker → offscreen document. Runtime messages are broadcast to
 *  every extension context, so each is wrapped with an explicit target and
 *  carries a WorkerRequest for the offscreen doc to relay to the worker. */
export type OffscreenRequest = { target: "offscreen"; request: WorkerRequest };

/** The worker's response as it reaches the SW: identical to WorkerResponse
 *  except the embed vectors arrive as a plain array (runtime messaging is
 *  JSON, so the transferable Float32Array can't survive this hop). */
export type OffscreenResponse =
  | {
      id: number;
      ok: true;
      type: "embed";
      dims: number;
      vectors: number[];
      workerStartedAt: number;
      embedsServed: number;
      backend: string;
      modelLoadMs: number;
      inferMs: number;
    }
  | { id: number; ok: true; type: "tier.set"; cleared: boolean; indexSize: number }
  | { id: number; ok: true; type: "index.add"; indexSize: number }
  | { id: number; ok: true; type: "index.remove"; indexSize: number }
  | { id: number; ok: true; type: "index.update"; indexSize: number; embedded: number; reused: number }
  | { id: number; ok: true; type: "search"; hits: DocHit[]; indexSize: number }
  | {
      id: number;
      ok: true;
      type: "index.stats";
      indexSize: number;
      docCount: number;
      backend: string;
      workerStartedAt: number;
    }
  | { id: number; ok: true; type: "index.save"; fileId: string; sizeBytes: number }
  | {
      id: number;
      ok: true;
      type: "index.load";
      loaded: boolean;
      indexSize: number;
      docCount: number;
      reason?: string;
    }
  | { id: number; ok: false; error: string };

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
  | { type: "embed.testResult"; ok: false; error: string }
  | {
      type: "embed.benchResult";
      ok: true;
      corpusSize: number;
      backend: string;
      /** Wall-clock throughput (texts/s) for each strategy. */
      singleTps: number;
      unsortedTps: number;
      sortedTps: number;
    }
  | { type: "embed.benchResult"; ok: false; error: string }
  | { type: "index.progress"; progress: IndexProgress }
  | { type: "search.results"; ok: true; hits: DocHit[]; indexSize: number }
  | { type: "search.results"; ok: false; error: string }
  | {
      type: "sync.result";
      ok: true;
      /** True on the very first sync, which only establishes the baseline. */
      baseline: boolean;
      changed: number;
      removed: number;
    }
  | { type: "sync.result"; ok: false; error: string }
  | {
      type: "tier.settings";
      settings: TierSettings;
      /** True when this change crossed embedding spaces and a full re-index
       *  was kicked off. */
      reindexing: boolean;
      error?: string;
    };

export function sendRequest(request: Request): Promise<Response> {
  return chrome.runtime.sendMessage({ ...request, target: "background" });
}
