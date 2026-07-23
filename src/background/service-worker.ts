import type { IndexProgress, Request, Response } from "../shared/messages";
import { AuthRequiredError, getAuthStatus, signIn } from "./auth";
import { exportDocs, listAllDocs } from "./drive";
import { embedTexts, embedBatched } from "./embedder-client";
import { searchDocs } from "./retrieval-client";
import {
  getIndexProgress,
  loadIndexOnStartup,
  maybeResumeOnStartup,
  pauseIndex,
  resumeIndex,
  startIndex,
} from "./indexer";
import { syncNow, syncOnStartup } from "./sync";

const SEARCH_K = 10;

// MV3 service workers are killed after ~30s of inactivity and restarted on
// demand. Top-level code runs on every (re)start, so this timestamp
// identifies the current worker instance in logs.
const startedAt = Date.now();
console.log(`[sw] started at ${new Date(startedAt).toISOString()}`);

const HEARTBEAT_ALARM = "heartbeat";

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[sw] onInstalled: ${details.reason}`);
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    console.log(`[sw] heartbeat (instance started ${new Date(startedAt).toISOString()})`);
  }
});

// On startup: restore a saved index from Drive (so search works with zero
// re-embedding), resume any interrupted first-run job, then pull incremental
// changes since the last sync.
void loadIndexOnStartup()
  .then(() => maybeResumeOnStartup())
  .then(() => syncOnStartup());

async function handle(request: Request): Promise<Response> {
  switch (request.type) {
    case "ping":
      return { type: "pong", startedAt };
    case "auth.getStatus":
      return { type: "auth.status", status: await getAuthStatus() };
    case "auth.signIn": {
      const status = await signIn();
      // First sign-in on a fresh profile: pull any saved index from Drive now
      // (startup load already ran before we were connected).
      if (status.state === "connected") void loadIndexOnStartup();
      return { type: "auth.status", status };
    }
    case "drive.listDocs":
      return listDocs();
    case "drive.exportAll":
      return exportAll();
    case "embed.test":
      return embedTest();
    case "embed.bench":
      return embedBench();
    case "index.start":
      return indexControl(startIndex);
    case "index.pause":
      return indexControl(pauseIndex);
    case "index.resume":
      return indexControl(resumeIndex);
    case "index.status":
      return indexControl(getIndexProgress);
    case "sync.now":
      return runSync();
    case "search":
      return runSearch(request.query);
  }
}

async function runSync(): Promise<Response> {
  try {
    const result = await syncNow();
    return { type: "sync.result", ok: true, ...result };
  } catch (error) {
    const message =
      error instanceof AuthRequiredError ? "Not connected to Google Drive." : String(error);
    console.error("[sync] failed", error);
    return { type: "sync.result", ok: false, error: message };
  }
}

// All four index.* controls return the same progress snapshot; start/resume
// surface a disconnected Drive as an error status rather than throwing.
async function indexControl(action: () => Promise<IndexProgress>): Promise<Response> {
  try {
    return { type: "index.progress", progress: await action() };
  } catch (error) {
    const message =
      error instanceof AuthRequiredError ? "Not connected to Google Drive." : String(error);
    console.error("[index] control failed", error);
    return {
      type: "index.progress",
      progress: {
        status: "error",
        doneDocs: 0,
        totalDocs: 0,
        doneChunks: 0,
        failedDocs: 0,
        backend: "",
        etaSeconds: null,
        error: message,
      },
    };
  }
}

async function runSearch(query: string): Promise<Response> {
  try {
    const { hits, indexSize } = await searchDocs(query, SEARCH_K);
    return { type: "search.results", ok: true, hits, indexSize };
  } catch (error) {
    console.error("[search] failed", error);
    return { type: "search.results", ok: false, error: String(error) };
  }
}

// Generates a varied-length synthetic corpus so the length-sort has real
// padding waste to eliminate (a uniform-length corpus would hide it).
function benchCorpus(size: number): string[] {
  const texts: string[] = [];
  for (let i = 0; i < size; i++) {
    const words = 8 + ((i * 37) % 190); // ~8..198 words → ~50..1200 chars
    texts.push(Array.from({ length: words }, (_, w) => `token${(i + w) % 100}`).join(" "));
  }
  return texts;
}

async function embedBench(): Promise<Response> {
  try {
    const corpus = benchCorpus(128);
    await embedTexts(["warm up the model before timing"]); // exclude load time

    const time = async (options: Parameters<typeof embedBatched>[2]) => {
      const t0 = Date.now();
      const result = await embedBatched(corpus, undefined, options);
      const ms = Date.now() - t0;
      return { tps: (corpus.length / ms) * 1000, backend: result.backend, batches: result.batches };
    };

    const single = await time({ maxBatchSize: 1, maxBatchChars: 1e9, sort: false });
    const unsorted = await time({ maxBatchSize: 32, maxBatchChars: 16000, sort: false });
    const sorted = await time({ maxBatchSize: 32, maxBatchChars: 16000, sort: true });

    console.log(
      `[bench] ${corpus.length} texts [${sorted.backend}] — ` +
        `single ${single.tps.toFixed(1)}/s, ` +
        `batched-unsorted ${unsorted.tps.toFixed(1)}/s (${unsorted.batches} batches), ` +
        `batched-sorted ${sorted.tps.toFixed(1)}/s (${sorted.batches} batches); ` +
        `sorted vs single = ${(sorted.tps / single.tps).toFixed(1)}×`,
    );
    return {
      type: "embed.benchResult",
      ok: true,
      corpusSize: corpus.length,
      backend: sorted.backend,
      singleTps: single.tps,
      unsortedTps: unsorted.tps,
      sortedTps: sorted.tps,
    };
  } catch (error) {
    console.error("[bench] failed", error);
    return { type: "embed.benchResult", ok: false, error: String(error) };
  }
}

async function embedTest(): Promise<Response> {
  try {
    // Index 0 is a fixed text for the determinism fingerprint; the rest
    // pad the batch so inferMs is large enough for a stable throughput
    // number to compare across backends (the ≥5× done-when for commit 8).
    const BATCH = 64;
    const texts = ["hello world"];
    for (let i = texts.length; i < BATCH; i++) {
      texts.push(`benchmark sentence number ${i} about quarterly planning and hiring budgets`);
    }
    const result = await embedTexts(texts);
    const textsPerSec = result.inferMs > 0 ? (result.count / result.inferMs) * 1000 : 0;
    console.log(
      `[embed] ${result.count} vectors × ${result.dims} dims [${result.backend}]; ` +
        `infer ${result.inferMs}ms → ${textsPerSec.toFixed(1)} texts/s; worker instance ` +
        `${new Date(result.workerStartedAt).toISOString()}, ${result.embedsServed} embeds served`,
    );
    // Determinism fingerprint: identical text must produce these exact
    // values in every session (done-when for commit 7).
    console.log(
      "[embed] fingerprint('hello world')[0..3] =",
      Array.from(result.vectors.slice(0, 4), (v) => v.toFixed(6)).join(", "),
    );
    return {
      type: "embed.testResult",
      ok: true,
      count: result.count,
      dims: result.dims,
      swStartedAt: startedAt,
      workerStartedAt: result.workerStartedAt,
      embedsServed: result.embedsServed,
      backend: result.backend,
      modelLoadMs: result.modelLoadMs,
      textsPerSec,
    };
  } catch (error) {
    console.error("[embed] test failed", error);
    return { type: "embed.testResult", ok: false, error: String(error) };
  }
}

async function exportAll(): Promise<Response> {
  try {
    const docs = await listAllDocs();
    console.log(`[drive] exporting ${docs.length} docs…`);
    const started = Date.now();
    const report = await exportDocs(docs, (done, total) => {
      if (done % 20 === 0 || done === total) console.log(`[drive] export ${done}/${total}`);
    });
    const totalChars = report.exported.reduce((sum, e) => sum + e.markdown.length, 0);
    const elapsedMs = Date.now() - started;
    console.log(
      `[drive] export finished: ${report.exported.length} ok, ` +
        `${report.failed.length} failed, ${totalChars} chars, ${Math.round(elapsedMs / 1000)}s`,
    );
    if (report.failed.length > 0) console.table(report.failed.map((f) => ({ name: f.doc.name, error: f.error })));
    return {
      type: "drive.exportReport",
      ok: true,
      exported: report.exported.length,
      failed: report.failed.length,
      totalChars,
      elapsedMs,
      failureSample: report.failed.slice(0, 3).map((f) => ({ name: f.doc.name, error: f.error })),
    };
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return { type: "drive.exportReport", ok: false, error: "Not connected to Google Drive." };
    }
    console.error("[drive] export run failed", error);
    return { type: "drive.exportReport", ok: false, error: String(error) };
  }
}

async function listDocs(): Promise<Response> {
  try {
    const docs = await listAllDocs();
    console.log(`[drive] inventory: ${docs.length} Google Docs`);
    console.table(docs);
    return {
      type: "drive.docList",
      ok: true,
      count: docs.length,
      sample: docs.slice(0, 5).map((d) => d.name),
    };
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return { type: "drive.docList", ok: false, error: "Not connected to Google Drive." };
    }
    console.error("[drive] files.list failed", error);
    return { type: "drive.docList", ok: false, error: String(error) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Ignore traffic addressed to other contexts (e.g. SW → offscreen).
  if ((message as { target?: string }).target !== "background") return false;
  const request = message as Request;
  handle(request).then(sendResponse, (error) => {
    console.error("[sw] handler failed", request.type, error);
    sendResponse({
      type: "auth.status",
      status: { state: "disconnected", reason: "error", detail: String(error) },
    } satisfies Response);
  });
  // Keep the message channel open for the async response.
  return true;
});
