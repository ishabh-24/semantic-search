import { getApiToken, invalidateCachedToken } from "./auth";
import type { DocMeta } from "../shared/messages";

// Thin Drive v3 REST client. Scope decision: the default "user" corpus
// (My Drive + docs individually shared with the user) — no shared-drive
// flags. Rate-limit backoff arrives with files.export in commit 4; plain
// listing is a handful of requests even for thousands of docs.

const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DOC_MIME_TYPE = "application/vnd.google-apps.document";

export class DriveApiError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`Drive API ${status}: ${body.slice(0, 200)}`);
    this.name = "DriveApiError";
  }
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
  if (!res.ok) throw new DriveApiError(res.status, await res.text());
  return res;
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

    const res = await authorizedFetch(`${FILES_URL}?${params}`);
    const page = (await res.json()) as FilesListPage;
    docs.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);

  return docs;
}
