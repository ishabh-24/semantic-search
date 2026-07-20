import { sendRequest, type AuthStatus } from "../shared/messages";
import type { DocHit } from "../shared/worker-protocol";

const status = document.getElementById("status")!;
const connectButton = document.getElementById("connect") as HTMLButtonElement;
const indexNowButton = document.getElementById("index-now") as HTMLButtonElement;
const query = document.getElementById("query") as HTMLInputElement;
const resultsEl = document.getElementById("results")!;
const devResult = document.getElementById("dev-result")!;

// ---- Auth status ----------------------------------------------------------

function render(auth: AuthStatus): void {
  connectButton.hidden = auth.state === "connected";
  indexNowButton.hidden = auth.state !== "connected";
  (document.getElementById("list-docs") as HTMLButtonElement).hidden = auth.state !== "connected";
  (document.getElementById("export-all") as HTMLButtonElement).hidden = auth.state !== "connected";

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
  refreshAuth({ type: "auth.signIn" }).finally(() => {
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
    status.textContent = response.error;
    return;
  }
  if (response.indexSize === 0) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Nothing indexed yet — run “Index my Docs” first.";
    resultsEl.replaceChildren(hint);
    return;
  }
  renderResults(response.hits);
}

let debounce: ReturnType<typeof setTimeout> | undefined;
query.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => void runSearch(query.value), 200);
});

// ---- Index Now (dev) ------------------------------------------------------

indexNowButton.addEventListener("click", async () => {
  indexNowButton.disabled = true;
  status.textContent = "Indexing your Docs… (progress in the SW console; this can take a while)";
  try {
    const response = await sendRequest({ type: "index.run" });
    if (response.type !== "index.done") return;
    status.textContent = response.ok
      ? `Indexed ${response.docs} docs → ${response.indexSize} chunks. Search away.`
      : `Indexing failed: ${response.error}`;
    if (response.ok && query.value.trim()) void runSearch(query.value);
  } finally {
    indexNowButton.disabled = false;
  }
});

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
