import type { DocMeta } from "../shared/messages";
import type { ChunkRecord } from "../shared/worker-protocol";
import { chunkDoc } from "../indexing/chunker";
import { AuthRequiredError, getApiToken } from "./auth";
import { DOC_MIME_TYPE, exportDocMarkdown, getStartPageToken, listChanges } from "./drive";
import { removeDocs, saveIndex, updateDoc } from "./retrieval-client";

// Incremental sync via the Drive changes feed. Instead of re-indexing the
// whole corpus, we keep a page-token cursor and, each sync, apply only what
// changed: re-index modified/added Docs (whole-doc re-embed for now; chunk-
// level diffing is commit 23) and tombstone deleted/trashed ones. Polls on
// startup and on demand ("Sync now"); no background alarm.

const TOKEN_KEY = "syncPageToken";

async function loadCursor(): Promise<string | null> {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  return (stored[TOKEN_KEY] as string | undefined) ?? null;
}

async function saveCursor(token: string): Promise<void> {
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
}

export type SyncOutcome = { baseline: boolean; changed: number; removed: number };

/** Records "track changes from now on." Called after a full index completes so
 *  edits made afterward are captured. */
export async function initSyncCursor(): Promise<void> {
  try {
    await saveCursor(await getStartPageToken());
  } catch (error) {
    console.warn("[sync] couldn't set baseline cursor", String(error));
  }
}

/** Applies everything that changed since the stored cursor. */
export async function syncNow(): Promise<SyncOutcome> {
  const token = await getApiToken(); // gates on being connected

  const cursor = await loadCursor();
  if (!cursor) {
    // No baseline yet (e.g. index restored from Drive on a new device) — start
    // tracking from now; there's nothing to replay.
    await saveCursor(await getStartPageToken());
    return { baseline: true, changed: 0, removed: 0 };
  }

  const { changes, newToken } = await listChanges(cursor);

  // Collapse the change feed to a final intent per file (changes are
  // chronological, so the last one for a file wins).
  const removeDocIds = new Set<string>();
  const reindex = new Map<string, DocMeta>();
  for (const change of changes) {
    const isDoc = change.file?.mimeType === DOC_MIME_TYPE;
    if (change.removed || change.file?.trashed || (change.file && !isDoc)) {
      removeDocIds.add(change.fileId);
      reindex.delete(change.fileId);
    } else if (isDoc && change.file) {
      reindex.set(change.fileId, {
        id: change.file.id,
        name: change.file.name,
        modifiedTime: change.file.modifiedTime,
      });
      removeDocIds.delete(change.fileId);
    }
  }

  // Tombstone deletions. Modified/added docs go through updateDoc, which
  // replaces their chunks and re-embeds only the ones whose text changed.
  if (removeDocIds.size > 0) await removeDocs([...removeDocIds]);

  let changed = 0;
  for (const meta of reindex.values()) {
    try {
      const markdown = await exportDocMarkdown(meta.id);
      const chunks: ChunkRecord[] = chunkDoc(meta, markdown).map((c) => ({
        id: c.id,
        docId: c.docId,
        docName: meta.name,
        breadcrumbs: c.breadcrumbs,
        text: c.text,
        modifiedTime: meta.modifiedTime,
      }));
      // Empty doc (e.g. all content removed) → just drop its old chunks.
      if (chunks.length > 0) await updateDoc(chunks);
      else await removeDocs([meta.id]);
      changed++;
    } catch (error) {
      if (error instanceof AuthRequiredError) throw error;
      console.warn(`[sync] skipping "${meta.name}": ${String(error)}`);
    }
  }

  await saveCursor(newToken);
  if (removeDocIds.size > 0 || changed > 0) {
    try {
      await saveIndex(token); // persist the freshened index
    } catch (error) {
      console.warn("[sync] Drive save failed (in-memory index is still updated):", String(error));
    }
  }
  return { baseline: false, changed, removed: removeDocIds.size };
}

/** Best-effort sync at service-worker startup; silent if not connected. */
export async function syncOnStartup(): Promise<void> {
  try {
    const result = await syncNow();
    if (!result.baseline) {
      console.log(`[sync] startup: ${result.changed} updated, ${result.removed} removed`);
    }
  } catch (error) {
    if (error instanceof AuthRequiredError) return;
    console.warn("[sync] startup failed", String(error));
  }
}
