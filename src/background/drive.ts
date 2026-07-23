import { AuthRequiredError, getApiToken, invalidateCachedToken } from "./auth";
import type { DocMeta } from "../shared/messages";

// Thin Drive v3 REST client. Scope decision: the default "user" corpus
// (My Drive + docs individually shared with the user) — no shared-drive
// flags.

const DRIVE_URL = "https://www.googleapis.com/drive/v3";
const FILES_URL = `${DRIVE_URL}/files`;
export const DOC_MIME_TYPE = "application/vnd.google-apps.document";
// Markdown keeps heading structure for the chunker (commit 5) with
// near-zero parsing; Drive exports Docs as text/markdown natively.
const EXPORT_MIME = "text/markdown";

const EXPORT_CONCURRENCY = 4;
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;

export class DriveApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`Drive API ${status}: ${body.slice(0, 200)}`);
    this.name = "DriveApiError";
  }
}

// Retry only what waiting can fix: 429, transient 5xx, and the 403s Drive
// uses for per-user rate limiting (the error body carries the reason).
// Other 403s (permission denied, export size cap) fail immediately.
function isRetriable(error: DriveApiError): boolean {
  if (error.status === 429 || error.status >= 500) return true;
  if (error.status === 403) {
    const body = error.body.toLowerCase();
    return body.includes("ratelimitexceeded") || body.includes("quotaexceeded");
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff with full jitter: 0.5–1s, 1–2s, 2–4s, 4–8s.
function backoffDelay(attempt: number): number {
  const base = BASE_DELAY_MS * 2 ** attempt;
  return base + Math.random() * base;
}

/** Bearer-authenticated fetch. On 401, evicts the cached token and retries
 *  once — Chrome mints a fresh token if the grant still stands; if the user
 *  revoked it, the retry throws AuthRequiredError for the UI to surface. */
async function authorizedFetch(url: string): Promise<globalThis.Response> {
  let token = await getApiToken();
  let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    await invalidateCachedToken(token);
    token = await getApiToken();
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) {
    const retryAfter = res.headers.get("Retry-After");
    const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 || null : null;
    throw new DriveApiError(res.status, await res.text(), retryAfterMs);
  }
  return res;
}

async function fetchWithBackoff(url: string): Promise<globalThis.Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await authorizedFetch(url);
    } catch (error) {
      const lastAttempt = attempt >= MAX_ATTEMPTS - 1;
      if (!(error instanceof DriveApiError) || !isRetriable(error) || lastAttempt) {
        throw error;
      }
      const delay = error.retryAfterMs ?? backoffDelay(attempt);
      console.warn(
        `[drive] ${error.status}, retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }
}

type FilesListPage = {
  nextPageToken?: string;
  files: DocMeta[];
};

/** Every non-trashed Google Doc in the user corpus, newest first. */
export async function listAllDocs(): Promise<DocMeta[]> {
  const docs: DocMeta[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      q: `mimeType='${DOC_MIME_TYPE}' and trashed=false`,
      pageSize: "1000",
      // Projection keeps responses small; modifiedTime feeds change
      // detection (V2) and recency tie-breaks in ranking (commit 12).
      fields: "nextPageToken,files(id,name,modifiedTime)",
      orderBy: "modifiedTime desc",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetchWithBackoff(`${FILES_URL}?${params}`);
    const page = (await res.json()) as FilesListPage;
    docs.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);

  return docs;
}

export async function exportDocMarkdown(docId: string): Promise<string> {
  const params = new URLSearchParams({ mimeType: EXPORT_MIME });
  const res = await fetchWithBackoff(`${FILES_URL}/${encodeURIComponent(docId)}/export?${params}`);
  return res.text();
}

// ---- Incremental change tracking (changes.list) --------------------------

export type DriveChange = {
  fileId: string;
  removed?: boolean;
  file?: {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime: string;
    trashed: boolean;
  };
};

/** A cursor marking "now" in the change feed; store it, then list changes
 *  relative to it later. */
export async function getStartPageToken(): Promise<string> {
  const res = await fetchWithBackoff(`${DRIVE_URL}/changes/startPageToken`);
  return ((await res.json()) as { startPageToken: string }).startPageToken;
}

/** All changes since `pageToken`, paginated internally, plus the new cursor
 *  to store for next time. */
export async function listChanges(
  pageToken: string,
): Promise<{ changes: DriveChange[]; newToken: string }> {
  const changes: DriveChange[] = [];
  let token = pageToken;
  for (;;) {
    const params = new URLSearchParams({
      pageToken: token,
      pageSize: "1000",
      fields:
        "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,trashed))",
    });
    const res = await fetchWithBackoff(`${DRIVE_URL}/changes?${params}`);
    const page = (await res.json()) as {
      changes?: DriveChange[];
      nextPageToken?: string;
      newStartPageToken?: string;
    };
    changes.push(...(page.changes ?? []));
    if (page.nextPageToken) {
      token = page.nextPageToken;
      continue;
    }
    return { changes, newToken: page.newStartPageToken ?? token };
  }
}

export type ExportedDoc = { doc: DocMeta; markdown: string };
export type ExportFailure = { doc: DocMeta; error: string };
export type ExportRunReport = {
  exported: ExportedDoc[];
  /** Docs that still failed after retries — recorded, never dropped. */
  failed: ExportFailure[];
};

/** Exports every doc through a fixed-size worker pool. Per-doc failures
 *  (after backoff retries) land in `failed`; a revoked grant aborts the
 *  whole run since every remaining request would fail the same way. */
export async function exportDocs(
  docs: DocMeta[],
  onProgress?: (done: number, total: number) => void,
): Promise<ExportRunReport> {
  const queue = [...docs];
  const exported: ExportedDoc[] = [];
  const failed: ExportFailure[] = [];
  let done = 0;
  let abort: AuthRequiredError | null = null;

  async function worker(): Promise<void> {
    for (;;) {
      const doc = queue.shift();
      if (!doc || abort) return;
      try {
        exported.push({ doc, markdown: await exportDocMarkdown(doc.id) });
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          abort = error;
          return;
        }
        failed.push({ doc, error: String(error) });
      }
      onProgress?.(++done, docs.length);
    }
  }

  const poolSize = Math.min(EXPORT_CONCURRENCY, docs.length);
  await Promise.all(Array.from({ length: poolSize }, worker));
  if (abort) throw abort;
  return { exported, failed };
}
