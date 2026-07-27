import { sendRequest, type AuthStatus, type IndexProgress } from "../shared/messages";
import type { DocHit } from "../shared/worker-protocol";

const status = document.getElementById("status")!;
const connectButton = document.getElementById("connect") as HTMLButtonElement;
const indexPanel = document.getElementById("index-panel")!;
const indexAction = document.getElementById("index-action") as HTMLButtonElement;
const syncNowButton = document.getElementById("sync-now") as HTMLButtonElement;
const indexBar = document.getElementById("index-bar") as HTMLProgressElement;
const indexProgress = document.getElementById("index-progress")!;
const syncResult = document.getElementById("sync-result")!;
const query = document.getElementById("query") as HTMLInputElement;
const resultsEl = document.getElementById("results")!;
const devResult = document.getElementById("dev-result")!;

// ---- Auth status ----------------------------------------------------------

function render(auth: AuthStatus): void {
  connectButton.hidden = auth.state === "connected";
  indexPanel.hidden = auth.state !== "connected";
  (document.getElementById("list-docs") as HTMLButtonElement).hidden = auth.state !== "connected";
  (document.getElementById("export-all") as HTMLButtonElement).hidden = auth.state !== "connected";
  // Note: index panel is refreshed explicitly (startup + after connect), not
  // here — renderIndex may call back into refreshAuth on an auth-loss error,
  // and auto-refreshing from render would risk a ping-pong loop.

  if (auth.state === "connected") {
    status.textContent = auth.email
      ? `Connected as ${auth.email}`
      : "Connected to Google Drive";
    return;
  }

  switch (auth.reason) {
    case "never_connected":
      status.textContent = "Connect your Google Drive to get started.";
      connectButton.textContent = "Connect Google Drive";
      break;
    case "revoked":
      status.textContent = "Access to Google Drive was revoked. Reconnect to continue.";
      connectButton.textContent = "Reconnect Google Drive";
      break;
    case "declined":
      status.textContent = "Consent window was closed. Connect to continue.";
      connectButton.textContent = "Connect Google Drive";
      break;
    case "chrome_signed_out":
      status.textContent = "Sign in to Chrome with a Google account first, then connect.";
      connectButton.textContent = "Retry";
      break;
    case "config":
      status.textContent =
        "OAuth client ID is missing or invalid — see docs/oauth-setup.md.";
      connectButton.hidden = true;
      break;
    default:
      status.textContent = `Something went wrong: ${auth.detail ?? "unknown error"}`;
      connectButton.textContent = "Retry";
  }
}

async function refreshAuth(request: { type: "auth.getStatus" } | { type: "auth.signIn" }) {
  const response = await sendRequest(request);
  if (response.type === "auth.status") render(response.status);
}

connectButton.addEventListener("click", () => {
  status.textContent = "Waiting for Google consent…";
  connectButton.disabled = true;
  refreshAuth({ type: "auth.signIn" })
    .then(() => void refreshIndex())
    .finally(() => {
      connectButton.disabled = false;
    });
});

// ---- Search ---------------------------------------------------------------

const DOC_URL = (docId: string) => `https://docs.google.com/document/d/${docId}/edit`;

function renderResults(hits: DocHit[]): void {
  resultsEl.replaceChildren();
  if (hits.length === 0) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "No matches.";
    resultsEl.append(hint);
    return;
  }
  for (const hit of hits) {
    const row = document.createElement("div");
    row.className = "result";
    row.title = "Open in Google Docs";

    const title = document.createElement("div");
    title.className = "result-title";
    title.textContent = hit.docName || "Untitled";
    row.append(title);

    if (hit.breadcrumbs.length > 0) {
      const crumb = document.createElement("div");
      crumb.className = "result-crumb";
      crumb.textContent = hit.breadcrumbs.join(" › ");
      row.append(crumb);
    }

    const snippet = document.createElement("div");
    snippet.className = "result-snippet";
    snippet.textContent = hit.snippet;
    row.append(snippet);

    // Deep link into the source doc (opening a URL needs no extra permission).
    row.addEventListener("click", () => chrome.tabs.create({ url: DOC_URL(hit.docId) }));
    resultsEl.append(row);
  }
}

let searchSeq = 0;
async function runSearch(q: string): Promise<void> {
  const trimmed = q.trim();
  if (!trimmed) {
    resultsEl.replaceChildren();
    return;
  }
  const seq = ++searchSeq;
  const response = await sendRequest({ type: "search", query: trimmed });
  // Ignore results from a stale keystroke that resolved out of order.
  if (seq !== searchSeq) return;
  if (response.type !== "search.results") return;
  if (!response.ok) {
    // Never leave the previous results sitting there looking valid.
    showNotice(`Search failed: ${response.error}. Try again in a moment.`);
    return;
  }
  if (response.indexSize === 0) {
    showNotice("Nothing indexed yet — run “Index my Docs” first.");
    return;
  }
  renderResults(response.hits);
}

/** Replaces the results area with a single hint/error line. */
function showNotice(text: string): void {
  const notice = document.createElement("p");
  notice.className = "hint";
  notice.textContent = text;
  resultsEl.replaceChildren(notice);
}

let debounce: ReturnType<typeof setTimeout> | undefined;
query.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => void runSearch(query.value), 200);
});

// ---- Indexing job (progress, pause/resume) --------------------------------

let lastIndexStatus: IndexProgress["status"] = "idle";
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function formatEta(seconds: number | null): string {
  if (seconds === null) return "estimating…";
  if (seconds < 60) return `~${seconds}s left`;
  return `~${Math.round(seconds / 60)}m left`;
}

function renderIndex(p: IndexProgress): void {
  lastIndexStatus = p.status;
  const active = p.status === "running" || p.status === "paused";
  const pct = p.totalDocs > 0 ? Math.round((p.doneDocs / p.totalDocs) * 100) : 0;

  indexBar.hidden = !active;
  indexBar.value = pct;
  indexProgress.hidden = p.status === "idle";

  switch (p.status) {
    case "idle":
      indexAction.textContent = "Index my Docs";
      indexAction.disabled = false;
      break;
    case "running":
      indexAction.textContent = "Pause";
      indexAction.disabled = false;
      indexProgress.textContent =
        `Indexing ${p.doneDocs}/${p.totalDocs} docs · ${p.doneChunks} chunks · ` +
        `${p.backend || "…"} · ${formatEta(p.etaSeconds)}${failedSuffix(p)}`;
      break;
    case "paused":
      indexAction.textContent = "Resume";
      indexAction.disabled = false;
      indexProgress.textContent = `Paused at ${p.doneDocs}/${p.totalDocs} docs · ${p.doneChunks} chunks`;
      break;
    case "done":
      indexAction.textContent = "Re-index";
      indexAction.disabled = false;
      indexProgress.textContent =
        p.failedDocs > 0
          ? `Indexed ${p.doneDocs - p.failedDocs} docs · ${p.doneChunks} chunks · ` +
            `${p.failedDocs} couldn't be indexed — Re-index to retry them`
          : `Indexed ${p.doneDocs} docs · ${p.doneChunks} chunks`;
      break;
    case "error":
      indexAction.textContent = "Retry";
      indexAction.disabled = false;
      indexProgress.textContent = p.error ?? "Indexing failed.";
      // An auth-loss error needs a reconnect, not just a retry — refresh the
      // auth panel so the Connect/Reconnect button reappears.
      if (p.error && /reconnect|not connected|drive access/i.test(p.error)) {
        void refreshAuth({ type: "auth.getStatus" });
      }
      break;
  }

  // Poll while the job is actively running; stop otherwise.
  clearTimeout(pollTimer);
  if (p.status === "running") pollTimer = setTimeout(() => void refreshIndex(), 500);
}

function failedSuffix(p: IndexProgress): string {
  return p.failedDocs > 0 ? ` · ${p.failedDocs} failed` : "";
}

async function refreshIndex(): Promise<void> {
  const response = await sendRequest({ type: "index.status" });
  if (response.type === "index.progress") {
    renderIndex(response.progress);
    // Surface freshly-indexed docs without needing a keystroke.
    if (query.value.trim()) void runSearch(query.value);
  }
}

indexAction.addEventListener("click", async () => {
  const request =
    lastIndexStatus === "running"
      ? ({ type: "index.pause" } as const)
      : lastIndexStatus === "paused"
        ? ({ type: "index.resume" } as const)
        : ({ type: "index.start" } as const);
  indexAction.disabled = true;
  const response = await sendRequest(request);
  if (response.type === "index.progress") renderIndex(response.progress);
});

syncNowButton.addEventListener("click", async () => {
  syncNowButton.disabled = true;
  syncResult.hidden = false;
  syncResult.textContent = "Checking Drive for changes…";
  try {
    const response = await sendRequest({ type: "sync.now" });
    if (response.type !== "sync.result") return;
    if (!response.ok) {
      syncResult.textContent = response.error;
      return;
    }
    syncResult.textContent = response.baseline
      ? "Now tracking changes from here on."
      : response.changed === 0 && response.removed === 0
        ? "Already up to date."
        : `Synced: ${response.changed} updated, ${response.removed} removed.`;
    // Reflect the freshened index in the panel and any active query.
    void refreshIndex();
    if (query.value.trim()) void runSearch(query.value);
  } finally {
    syncNowButton.disabled = false;
  }
});

// ---- Embedding tier -------------------------------------------------------

const tierRadios = document.querySelectorAll<HTMLInputElement>('input[name="tier"]');
const cloudFields = document.getElementById("cloud-fields")!;
const cloudEndpoint = document.getElementById("cloud-endpoint") as HTMLInputElement;
const cloudKey = document.getElementById("cloud-key") as HTMLInputElement;
const tierApply = document.getElementById("tier-apply") as HTMLButtonElement;
const tierStatus = document.getElementById("tier-status")!;

function selectedTier(): "local" | "cloud" {
  return [...tierRadios].find((r) => r.checked)?.value === "cloud" ? "cloud" : "local";
}

function renderTier(settings: { tier: "local" } | { tier: "cloud"; endpoint: string; apiKey: string }): void {
  for (const radio of tierRadios) radio.checked = radio.value === settings.tier;
  cloudFields.hidden = settings.tier !== "cloud";
  if (settings.tier === "cloud") {
    cloudEndpoint.value = settings.endpoint;
    cloudKey.value = settings.apiKey;
  }
}

for (const radio of tierRadios) {
  radio.addEventListener("change", () => {
    cloudFields.hidden = selectedTier() !== "cloud";
  });
}

tierApply.addEventListener("click", async () => {
  const settings =
    selectedTier() === "cloud"
      ? ({ tier: "cloud", endpoint: cloudEndpoint.value.trim(), apiKey: cloudKey.value.trim() } as const)
      : ({ tier: "local" } as const);
  if (settings.tier === "cloud" && (!settings.endpoint || !settings.apiKey)) {
    tierStatus.hidden = false;
    tierStatus.textContent = "Cloud tier needs both an endpoint URL and an API key.";
    return;
  }
  tierApply.disabled = true;
  tierStatus.hidden = false;
  tierStatus.textContent = "Applying…";
  try {
    const response = await sendRequest({ type: "tier.set", settings });
    if (response.type !== "tier.settings") return;
    if (response.error) {
      tierStatus.textContent = `Couldn't apply: ${response.error}`;
      return;
    }
    tierStatus.textContent = response.reindexing
      ? "Tier switched — the index was cleared and a full re-index just started."
      : "Saved.";
    if (response.reindexing) void refreshIndex();
  } finally {
    tierApply.disabled = false;
  }
});

async function refreshTier(): Promise<void> {
  const response = await sendRequest({ type: "tier.get" });
  if (response.type === "tier.settings") renderTier(response.settings);
}

// ---- Dev tools ------------------------------------------------------------

const listDocsButton = document.getElementById("list-docs") as HTMLButtonElement;
listDocsButton.addEventListener("click", async () => {
  listDocsButton.disabled = true;
  devResult.hidden = false;
  devResult.textContent = "Listing docs…";
  try {
    const response = await sendRequest({ type: "drive.listDocs" });
    if (response.type !== "drive.docList") return;
    devResult.textContent = response.ok
      ? `${response.count} Google Docs found. Newest: ${response.sample.join(" · ")}`
      : response.error;
  } finally {
    listDocsButton.disabled = false;
  }
});

const exportAllButton = document.getElementById("export-all") as HTMLButtonElement;
exportAllButton.addEventListener("click", async () => {
  exportAllButton.disabled = true;
  devResult.hidden = false;
  devResult.textContent = "Exporting all docs…";
  try {
    const response = await sendRequest({ type: "drive.exportAll" });
    if (response.type !== "drive.exportReport") return;
    devResult.textContent = response.ok
      ? `Exported ${response.exported} docs (${Math.round(response.totalChars / 1000)}k chars) ` +
        `in ${Math.round(response.elapsedMs / 1000)}s; ${response.failed} failed.`
      : response.error;
  } finally {
    exportAllButton.disabled = false;
  }
});

const embedTestButton = document.getElementById("embed-test") as HTMLButtonElement;
embedTestButton.addEventListener("click", async () => {
  embedTestButton.disabled = true;
  devResult.hidden = false;
  devResult.textContent = "Embedding test texts…";
  try {
    const response = await sendRequest({ type: "embed.test" });
    if (response.type !== "embed.testResult") return;
    devResult.textContent = response.ok
      ? `${response.count} vectors × ${response.dims} dims [${response.backend}] · ` +
        `${response.textsPerSec.toFixed(0)} texts/s · model loaded in ` +
        `${(response.modelLoadMs / 1000).toFixed(1)}s · worker up since ` +
        `${new Date(response.workerStartedAt).toLocaleTimeString()} · SW instance ` +
        `${new Date(response.swStartedAt).toLocaleTimeString()}`
      : response.error;
  } finally {
    embedTestButton.disabled = false;
  }
});

const embedBenchButton = document.getElementById("embed-bench") as HTMLButtonElement;
embedBenchButton.addEventListener("click", async () => {
  embedBenchButton.disabled = true;
  devResult.hidden = false;
  devResult.textContent = "Benchmarking (single vs batched vs sorted)…";
  try {
    const response = await sendRequest({ type: "embed.bench" });
    if (response.type !== "embed.benchResult") return;
    devResult.textContent = response.ok
      ? `${response.corpusSize} texts [${response.backend}] · single ${response.singleTps.toFixed(0)}/s → ` +
        `batched ${response.unsortedTps.toFixed(0)}/s → sorted ${response.sortedTps.toFixed(0)}/s ` +
        `(${(response.sortedTps / response.singleTps).toFixed(1)}× vs single)`
      : response.error;
  } finally {
    embedBenchButton.disabled = false;
  }
});

await refreshAuth({ type: "auth.getStatus" });
void refreshIndex();
void refreshTier();
