import type { DocMeta, IndexProgress } from "../shared/messages";
import type { ChunkRecord } from "../shared/worker-protocol";
import { chunkDoc } from "../indexing/chunker";
import { AuthRequiredError } from "./auth";
import { listAllDocs, exportDocMarkdown } from "./drive";
import { indexChunks, indexStats } from "./retrieval-client";

// Background first-run indexing job. The unit of progress and resumability
// is one document: export → chunk → embed+index → mark done → persist the
// cursor. Persisting after each doc to chrome.storage.local means an
// interruption (service-worker death, popup close, pause) resumes from the
// last completed doc rather than from zero.
//
// The index itself lives only in the offscreen worker's memory until commit
// 16. So on resume we compare the worker's instance id against the one the
// cursor was built against: same worker ⇒ the indexed docs are still there,
// resume from the cursor; different worker (it was wiped by a restart) ⇒ the
// cursor is meaningless, re-index from zero. This is what keeps a resumed
// job from producing an index that's silently missing its early documents.

const JOB_KEY = "indexJob";

type PersistedJob = {
  status: "running" | "paused" | "done" | "error";
  docs: DocMeta[];
  doneDocIds: string[];
  doneChunks: number;
  /** workerStartedAt of the worker the cursor was built against. */
  workerInstanceId: number;
  backend: string;
  startedAt: number;
  error?: string;
};

let currentJob: PersistedJob | null = null;
let loopActive = false;
// Throughput of the current running stretch, for the ETA (reset on each
// (re)bind so pauses/restarts don't skew it). In-memory only.
let sessionStartAt = 0;
let sessionStartChunks = 0;

async function loadJob(): Promise<PersistedJob | null> {
  const stored = await chrome.storage.local.get(JOB_KEY);
  return (stored[JOB_KEY] as PersistedJob | undefined) ?? null;
}

async function saveJob(job: PersistedJob): Promise<void> {
  currentJob = job;
  await chrome.storage.local.set({ [JOB_KEY]: job });
}

function estimateEta(job: PersistedJob): number | null {
  if (job.status !== "running" || sessionStartAt === 0) return null;
  const elapsed = (Date.now() - sessionStartAt) / 1000;
  const chunksThisSession = job.doneChunks - sessionStartChunks;
  const doneDocs = job.doneDocIds.length;
  if (elapsed < 2 || chunksThisSession <= 0 || doneDocs === 0) return null;
  const chunksPerSec = chunksThisSession / elapsed;
  const avgChunksPerDoc = job.doneChunks / doneDocs;
  const totalChunksEst = avgChunksPerDoc * job.docs.length;
  const remaining = Math.max(0, totalChunksEst - job.doneChunks);
  return Math.round(remaining / chunksPerSec);
}

function toProgress(job: PersistedJob | null): IndexProgress {
  if (!job) {
    return { status: "idle", doneDocs: 0, totalDocs: 0, doneChunks: 0, backend: "", etaSeconds: null };
  }
  return {
    status: job.status,
    doneDocs: job.doneDocIds.length,
    totalDocs: job.docs.length,
    doneChunks: job.doneChunks,
    backend: job.backend,
    etaSeconds: estimateEta(job),
    error: job.error,
  };
}

export async function getIndexProgress(): Promise<IndexProgress> {
  currentJob ??= await loadJob();
  return toProgress(currentJob);
}

/** Starts a fresh job over the full corpus. Idempotent worker-side add means
 *  re-running skips already-indexed chunks rather than duplicating them. */
export async function startIndex(): Promise<IndexProgress> {
  const docs = await listAllDocs(); // throws AuthRequiredError if disconnected
  const stats = await indexStats(); // also ensures the offscreen worker exists
  await saveJob({
    status: "running",
    docs,
    doneDocIds: [],
    doneChunks: 0,
    workerInstanceId: stats.workerStartedAt,
    backend: stats.backend,
    startedAt: Date.now(),
  });
  void runLoop();
  return toProgress(currentJob);
}

export async function pauseIndex(): Promise<IndexProgress> {
  currentJob ??= await loadJob();
  if (currentJob && currentJob.status === "running") {
    currentJob.status = "paused";
    await saveJob(currentJob);
  }
  return toProgress(currentJob);
}

export async function resumeIndex(): Promise<IndexProgress> {
  currentJob ??= await loadJob();
  if (currentJob && (currentJob.status === "paused" || currentJob.status === "error")) {
    currentJob.status = "running";
    delete currentJob.error;
    await saveJob(currentJob);
    void runLoop();
  }
  return toProgress(currentJob);
}

/** Called at service-worker startup: if a job was mid-flight when the worker
 *  died, pick it back up. */
export async function maybeResumeOnStartup(): Promise<void> {
  currentJob = await loadJob();
  if (currentJob?.status === "running") void runLoop();
}

async function runLoop(): Promise<void> {
  if (loopActive) return; // one loop at a time; it always reads currentJob
  loopActive = true;
  try {
    let boundJob: PersistedJob | null = null;
    let doneSet = new Set<string>();

    for (;;) {
      const job = currentJob;
      if (!job || job.status !== "running") break;

      // (Re)bind when the active job object changes (start / resume / restart).
      if (job !== boundJob) {
        boundJob = job;
        await reconcileStaleness(job);
        doneSet = new Set(job.doneDocIds);
        sessionStartAt = Date.now();
        sessionStartChunks = job.doneChunks;
      }

      const next = job.docs.find((d) => !doneSet.has(d.id));
      if (!next) {
        job.status = "done";
        await saveJob(job);
        break;
      }

      try {
        const markdown = await exportDocMarkdown(next.id);
        const chunks: ChunkRecord[] = chunkDoc(next, markdown).map((c) => ({
          id: c.id,
          docId: c.docId,
          docName: next.name,
          breadcrumbs: c.breadcrumbs,
          text: c.text,
          modifiedTime: next.modifiedTime,
        }));
        if (chunks.length > 0) await indexChunks(chunks);
        job.doneChunks += chunks.length;
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          job.status = "error";
          job.error = "Google Drive access was lost. Reconnect, then resume.";
          await saveJob(job);
          break;
        }
        // One bad doc (e.g. export too large) must not stall the whole job.
        console.warn(`[index] skipping "${next.name}": ${String(error)}`);
      }

      doneSet.add(next.id);
      job.doneDocIds.push(next.id);
      await saveJob(job);
    }
  } finally {
    loopActive = false;
  }
}

/** If the worker that holds the index has been replaced (restart wiped it),
 *  the cursor can't be trusted — reset it so we re-index from zero. */
async function reconcileStaleness(job: PersistedJob): Promise<void> {
  try {
    const stats = await indexStats();
    if (stats.workerStartedAt !== job.workerInstanceId) {
      console.log("[index] worker restarted since cursor was written — re-indexing from zero");
      job.doneDocIds = [];
      job.doneChunks = 0;
      job.workerInstanceId = stats.workerStartedAt;
      job.backend = stats.backend;
      await saveJob(job);
    }
  } catch {
    // Worker unreachable; the export/index calls below will surface the error.
  }
}
