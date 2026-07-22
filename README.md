# Drive Semantic Search

Meaning-based search over your Google Docs, as a Manifest V3 Chrome extension —
**without any third-party server ever holding your content.**

Type *"money our clients still owe us"* and it finds `invoice_2024_Q3_final`,
even though the doc never uses those words. Type the exact filename and it finds
that too. Click a result to open the doc.

## The thesis

A search index does not require a shadow copy of your data on someone else's
infrastructure. Everything that touches your document text happens **on your
device**:

- Documents are exported from Drive and **embedded on-device** by a MiniLM
  sentence-transformer (transformers.js + ONNX Runtime Web).
- The index — vectors **and** text — is searched locally.
- The only place the index is *stored* is **your own Google Drive**, in a
  hidden app-scoped folder (`appDataFolder`). That makes it durable, private,
  and automatically synced across your devices, with **zero infrastructure
  owned by this project.**

No account to create, no server to trust, no content leaving your control.

## How it works

```mermaid
flowchart TB
  subgraph EXT["Chrome Extension (MV3)"]
    Popup["Popup UI<br/>search · indexing progress"]
    SW["Service Worker<br/>orchestration · OAuth · Drive API"]
    subgraph OFF["Offscreen Document (survives SW restarts)"]
      Worker["Web Worker<br/>MiniLM embedder<br/>vector index + lexical index + RRF"]
    end
  end
  Drive[("Google Drive<br/>your Docs")]
  AppData[("Drive appDataFolder<br/>index.bin (private)")]
  HF[("Hugging Face<br/>MiniLM weights")]

  Popup <-->|typed messages| SW
  SW <-->|typed messages| Worker
  SW -->|files.list · files.export| Drive
  Worker -->|save / load index| AppData
  Worker -.->|one-time model download| HF
```

**Indexing pipeline.** Authenticate (`chrome.identity`) → list Docs
(`files.list`) → export each as Markdown (`files.export`, with backoff +
concurrency cap) → chunk on heading/paragraph structure (with heading
breadcrumbs and overlap) → embed on-device in length-sorted batches. The model
runs in a Web Worker inside an **offscreen document**, so it stays warm across
MV3 service-worker restarts and never blocks a UI thread. WebGPU is used when
available, with a WASM fallback.

**Retrieval is hybrid.** A flat float32 vector index (brute-force cosine —
[measured](docs/benchmarks.md) at <16 ms over 60k×384, ample at personal-Drive
scale) is fused with a [MiniSearch](https://github.com/lucaong/minisearch)
lexical index via **reciprocal rank fusion** (k=60). So exact-name lookups and
fuzzy conceptual queries both work, and neither has to win alone. Results are
collapsed to one hit per document with a breadcrumb and snippet.

**Persistence & durability.** The index is int8-quantized (per-vector scale) +
gzipped text in a versioned, checksummed envelope, saved to `appDataFolder`.
It loads on startup and after sign-in — a fresh browser profile restores full
search with **zero re-embedding**. Concurrent edits from two devices reconcile
via Drive's `headRevisionId`: on a conflict we merge (union of docs,
last-write-wins per doc) rather than clobber.

## Retrieval quality

48 labeled queries over a 16-doc fixture corpus, split between exact-name
lookups and paraphrases. Reproduce with `npm run eval` (embeds with the shipped
model and drives the real retrieval code):

| mode | recall@1 | recall@5 | MRR |
|------|----------|----------|-----|
| lexical | 0.917 | 1.000 | 0.958 |
| semantic | 0.896 | 0.979 | 0.936 |
| **hybrid** | **1.000** | **1.000** | **1.000** |

Hybrid ranks the correct doc #1 on every query — RRF recovers what each single
mode misses. (recall@5 saturates at this corpus size, so recall@1 and MRR are
the discriminating metrics.) See [docs/benchmarks.md](docs/benchmarks.md).

## Getting started

```bash
npm install
npm run build      # outputs dist/
npm test           # unit tests
npm run eval       # retrieval quality numbers
```

1. Configure a Google OAuth client — see [docs/oauth-setup.md](docs/oauth-setup.md).
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/`.
3. Open the popup → **Connect Google Drive** → **Index my Docs**.

## Tech

TypeScript · esbuild · Manifest V3 (offscreen document + Web Worker) ·
transformers.js / ONNX Runtime Web (`Xenova/all-MiniLM-L6-v2`, 384-dim,
pinned revision) · MiniSearch · Vitest. No UI framework — the popup is
vanilla TS.

## Limitations & trade-offs

- **First-run cost.** Initial indexing embeds your entire corpus on-device —
  minutes for a large Drive — plus a one-time ~25 MB model download. It's
  resumable and runs in the background, and every later launch restores from
  Drive with no re-embedding.
- **Google Docs only.** Sheets, Slides, PDFs, and other Drive files are not
  indexed yet.
- **Changes need a re-index.** There's no automatic change detection or
  deletion handling yet; re-indexing picks up edits (unchanged docs are skipped
  cheaply). Incremental sync is on the roadmap.
