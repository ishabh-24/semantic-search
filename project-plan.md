# Drive Semantic Search — Technical Description & Commit Plan

## Technical description

**V1 — local-first hybrid search.** A Manifest V3 Chrome extension that adds meaning-based search over a user's Google Docs without any third-party server ever holding their content. On first run, the extension authenticates via `chrome.identity` (scopes: `drive.readonly`, `drive.appdata`), lists and exports the user's Docs through the Drive API, and chunks them on structural boundaries (headings/paragraphs, with overlap and heading breadcrumbs). Each chunk is embedded **on-device** by a MiniLM-L6 sentence-transformer running in transformers.js (ONNX Runtime Web, WebGPU with WASM fallback), hosted in a Web Worker inside an offscreen document so the model stays warm across MV3 service-worker restarts and inference never blocks a UI thread. Retrieval is **hybrid**: a flat float32 vector index searched by brute-force cosine similarity (measured as sufficient at personal-Drive scale, ~50–200k chunks) is fused with a MiniSearch lexical index via reciprocal rank fusion, so exact-name lookups and fuzzy conceptual queries both work. The full index — int8-quantized vectors plus gzipped chunk text and a version stamp — is persisted to the user's own Drive `appDataFolder`, a hidden app-scoped folder, which makes the index durable, private, and automatically synced across the user's devices with no infrastructure owned by the project. Search lives in the extension popup, returns top-k chunks with breadcrumb context, and deep-links into the source doc. Retrieval quality is validated against a ~50-query labeled eval set, reporting recall@5 for lexical-only, semantic-only, and hybrid modes.

**V2 — incremental sync and an opt-in stateless cloud tier.** V2 replaces full re-indexing with incremental sync driven by the Drive `changes.list` feed (page-token cursor, chunk-level re-embedding of modified docs only) and adds an omnibox keyword for address-bar search. It also introduces an **opt-in cloud embedding tier** for higher retrieval quality: because an API credential cannot ship inside an inspectable extension bundle, a minimal AWS pipeline — API Gateway (rate limiting/auth) fronting a stateless Lambda `/embed` endpoint that invokes an Amazon Bedrock embedding model — holds the credential server-side while persisting nothing (text in, vector out; the Lambda's IAM role is scoped to Bedrock-invoke and CloudWatch-logs only). CloudWatch alarms cover error rate and throttling, and the Lambda is deployed through a GitHub Actions CI/CD pipeline with infrastructure-as-code. The embedder worker becomes a router that selects local MiniLM or the cloud tier per user preference, preserving the core architectural thesis in both modes: a search index does not require a shadow copy of the user's data on someone else's infrastructure.

---

## Commit plan

Conventional-commit style. Each commit is scoped to be independently reviewable, with a "done when" acceptance check. Order matters — each commit builds on the last, and the project is demoable from commit 13 onward.

### V1 — Phase 0: Skeleton

| # | Commit | Scope | Done when |
|---|--------|-------|-----------|
| 1 | `chore: scaffold MV3 extension with build tooling` | manifest.json (MV3), popup shell, service worker stub, Vite + CRXJS (or esbuild) build, TypeScript config | Extension loads unpacked, popup opens, SW logs a heartbeat |
| 2 | `feat: OAuth flow via chrome.identity` | `getAuthToken` acquisition, interactive consent, token caching, explicit revoked-token detection path | Token retrieved; revoking access in Google account settings surfaces a re-auth prompt, not a silent failure |
| 3 | `feat: Drive client — list Google Docs` | `files.list` filtered to `application/vnd.google-apps.document`, pagination, fields projection (id, name, modifiedTime) | Full doc inventory logged for a test account with >100 docs |
| 4 | `feat: Drive client — export doc text` | `files.export` per doc, retry with backoff on 403/429 rate limits, concurrency cap | All docs export without tripping quota; failures retried, not dropped |

### V1 — Phase 1: Indexing pipeline

| # | Commit | Scope | Done when |
|---|--------|-------|-----------|
| 5 | `feat: structural chunker` | Split on headings/paragraphs, target chunk size (~256 tokens), overlap, heading-breadcrumb metadata per chunk; unit tests with fixture docs | Tests pass; a nested-heading fixture yields correct breadcrumbs like `Q3 Planning › Budget › Headcount` |
| 6 | `feat: offscreen document + embedder worker scaffold` | `chrome.offscreen` lifecycle, dedicated worker inside it, typed message protocol (`{type:'embed', texts}` → `Float32Array`), keep-alive across SW restarts | SW can be killed (via chrome://serviceworker-internals) and the next embed call succeeds without model reload |
| 7 | `feat: transformers.js MiniLM integration (WASM)` | Pipeline load with pinned model revision, mean pooling + L2 normalize, WASM binaries bundled for MV3 CSP, Cache API model caching | Cold load downloads once; warm load <2s; identical text → identical vector across sessions |
| 8 | `feat: WebGPU backend with WASM fallback` | Feature-detect, `device:'webgpu'`, record active backend for progress estimates | On a WebGPU machine, throughput ≥5x WASM baseline; fallback verified with WebGPU disabled |
| 9 | `feat: length-sorted batched embedding` | Batch size ~16–32, sort chunks by token length before batching to minimize padding waste, memory ceiling guard | Indexing throughput improves measurably vs. one-at-a-time; no OOM on a 10k-chunk corpus |

### V1 — Phase 2: Retrieval

| # | Commit | Scope | Done when |
|---|--------|-------|-----------|
| 10 | `feat: in-memory vector index` | Flat float32 array + parallel metadata array, brute-force cosine (dot product on unit vectors) top-k in a worker | Top-k over 60k×384 vectors returns in <100ms; benchmark recorded in README notes |
| 11 | `feat: lexical index via MiniSearch` | Index same chunks (text + title + breadcrumbs), tokenization config, runs in the same worker | Exact filename-style query ranks the right doc #1 lexically |
| 12 | `feat: reciprocal rank fusion` | RRF (k=60) over both ranked lists, dedupe by chunk id, tie-break by doc recency | Hybrid returns sane results for both "invoice_2024_final" and "that doc about hiring budget" style queries |

### V1 — Phase 3: Product surface

| # | Commit | Scope | Done when |
|---|--------|-------|-----------|
| 13 | `feat: popup search UI` | Query input, debounced search, top-k results with breadcrumb + snippet, deep links opening the doc | End-to-end demo works: type query → click result → correct doc opens |
| 14 | `feat: first-run indexing flow` | Progress UI (docs done / total, backend-aware ETA), search-what's-indexed-so-far, pause/resume | Killing the browser mid-index resumes rather than restarting from zero |

### V1 — Phase 4: Persistence & durability

| # | Commit | Scope | Done when |
|---|--------|-------|-----------|
| 15 | `feat: index serialization` | int8 quantization of vectors (+ per-vector scale), gzip chunk text, versioned binary envelope | Serialized 60k-chunk index ≤ ~30MB; round-trip preserves recall@5 within noise of float32 |
| 16 | `feat: appDataFolder persistence` | Save/load via `drive.appdata`, load-on-startup, save-after-index, integrity check on load | Fresh browser profile + sign-in restores full search with zero re-embedding |
| 17 | `feat: two-device conflict handling` | Version counter + doc-revision map; on conflict, merge by union of chunk sets keyed on doc revision id, last-write-wins metadata | Simulated concurrent writes from two profiles converge without index corruption |
| 18 | `fix: error states and token revocation UX` | Revoked token, quota exhaustion, offline, corrupt index → each has an explicit UI state, none fail silently | Every failure mode shows an actionable message; no stale-results-forever path exists |

### V1 — Phase 5: Evaluation & polish

| # | Commit | Scope | Done when |
|---|--------|-------|-----------|
| 19 | `test: retrieval eval harness` | ~50 labeled query→doc pairs, recall@5 + MRR for lexical / semantic / hybrid, results table generator | Numbers reproducible via one script; hybrid ≥ both single modes (or the analysis explains why not) |
| 20 | `docs: README` | Architecture diagram, no-shadow-copy thesis, eval chart, explicit limitations section (restricted-scope verification trade-off, first-run cost, Docs-only) | A stranger can understand what it is, why it's shaped this way, and what it doesn't do |
| 21 | `chore: demo assets` | Seed script populating a demo Google account (~100 varied docs), 2-minute recorded walkthrough | Interview-ready demo independent of personal Drive |

### V2 — Incremental sync & reach

| # | Commit | Scope | Done when |
|---|--------|-------|-----------|
| 22 | `feat: incremental sync via changes.list` | Stored page-token cursor, poll on startup/alarm, re-export + re-chunk changed docs only, tombstone deleted docs | Editing one doc re-embeds only that doc's chunks; deletions disappear from results |
| 23 | `feat: chunk-level diffing` | Hash chunks; re-embed only changed chunks within a modified doc | Editing one paragraph re-embeds ~1 chunk, not the whole doc |
| 24 | `feat: omnibox keyword search` | `omnibox` API keyword, suggestions from hybrid search, enter → open doc | Address-bar `drv hiring budget` surfaces correct suggestions |

### V2 — AWS opt-in tier

| # | Commit | Scope | Done when |
|---|--------|-------|-----------|
| 25 | `infra: IaC for embed endpoint` | AWS SAM or CDK: API Gateway + Lambda + IAM role scoped to Bedrock-invoke + CloudWatch-logs only | `sam deploy` from clean checkout stands up the whole stack; IAM policy passes least-privilege review |
| 26 | `feat: Lambda /embed handler` | Stateless handler: validate, invoke Bedrock embedding model, return vector; no persistence, no request-body logging | Load test confirms nothing written to any store; response schema matches local embedder |
| 27 | `infra: rate limiting + alarms` | API Gateway usage plan/throttles, CloudWatch alarms on error rate and throttle count | Simulated abuse gets throttled; alarm fires and notifies |
| 28 | `feat: cloud-tier routing in embedder worker` | Settings opt-in, per-request router (local MiniLM vs. cloud), dimension/versioning guard so mixed-model vectors never share an index | Toggling tiers triggers a clean re-embed; index never mixes embedding spaces |
| 29 | `ci: GitHub Actions deploy pipeline` | Lint/test on PR; on tag, build + deploy Lambda via IaC; extension build artifact uploaded | Merge-to-main is test-gated; tagged release deploys AWS stack hands-free |
