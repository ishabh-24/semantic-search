// Token-based Drive appDataFolder client. The appDataFolder is a hidden,
// app-scoped folder in the user's own Drive — durable, private, and synced
// across their devices with zero project-owned infrastructure. This module
// takes the OAuth token as a parameter (no chrome.identity) so it can run
// inside the worker, where the serialized index bytes already live.

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

/** Fixed filename for the single index blob in appDataFolder. */
export const INDEX_FILENAME = "index.bin";

/** A reference to the stored index blob. headRevisionId changes on every
 *  write, so comparing it detects a concurrent write from another device. */
export type IndexFileRef = { id: string; headRevisionId: string };

function auth(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function ensureOk(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`Drive ${what} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

/** The index blob's ref in appDataFolder, or null if none saved yet. */
export async function findIndexFile(token: string): Promise<IndexFileRef | null> {
  const params = new URLSearchParams({
    spaces: "appDataFolder",
    q: `name='${INDEX_FILENAME}'`,
    fields: "files(id,headRevisionId)",
  });
  const res = await ensureOk(
    await fetch(`${DRIVE}/files?${params}`, { headers: auth(token) }),
    "files.list",
  );
  const body = (await res.json()) as { files?: IndexFileRef[] };
  return body.files?.[0] ?? null;
}

/** Creates or overwrites the index blob; returns its new ref (with the fresh
 *  headRevisionId, so the caller can track what it just wrote). */
export async function uploadIndex(
  token: string,
  existingFileId: string | null,
  bytes: ArrayBuffer,
): Promise<IndexFileRef> {
  let fileId = existingFileId;
  if (!fileId) {
    const res = await ensureOk(
      await fetch(`${DRIVE}/files`, {
        method: "POST",
        headers: { ...auth(token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: INDEX_FILENAME, parents: ["appDataFolder"] }),
      }),
      "files.create",
    );
    fileId = ((await res.json()) as { id: string }).id;
  }
  const res = await ensureOk(
    await fetch(`${UPLOAD}/files/${fileId}?uploadType=media&fields=id,headRevisionId`, {
      method: "PATCH",
      headers: auth(token),
      body: bytes,
    }),
    "media upload",
  );
  return (await res.json()) as IndexFileRef;
}

export async function downloadIndex(token: string, fileId: string): Promise<ArrayBuffer> {
  const res = await ensureOk(
    await fetch(`${DRIVE}/files/${fileId}?alt=media`, { headers: auth(token) }),
    "media download",
  );
  return res.arrayBuffer();
}
