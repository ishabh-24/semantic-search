import type { DocHit } from "../shared/worker-protocol";
import { searchDocs } from "./retrieval-client";

// Address-bar search: type the keyword (`drv`) then a query and get
// suggestions from the hybrid index; Enter opens the doc. Lives in the
// service worker (where chrome.omnibox is available); listeners are
// registered synchronously at SW load so the event can wake the worker.

const DOC_BASE = "https://docs.google.com/document/d/";
const SUGGEST_K = 5;
// Debounce so we don't embed a query on every keystroke.
const DEBOUNCE_MS = 150;

export function docUrl(docId: string): string {
  return `${DOC_BASE}${docId}/edit`;
}

/** Omnibox descriptions are XML; dynamic text (doc names, snippets) must be
 *  escaped or a stray & or < breaks the whole suggestion. */
export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatSuggestion(hit: DocHit): chrome.omnibox.SuggestResult {
  const crumb = hit.breadcrumbs.length > 0 ? `${hit.breadcrumbs.join(" › ")} — ` : "";
  const detail = xmlEscape(`${crumb}${hit.snippet}`.slice(0, 100));
  return {
    // `content` is what onInputEntered receives when this row is chosen.
    content: docUrl(hit.docId),
    description: `<match>${xmlEscape(hit.docName)}</match> <dim>${detail}</dim>`,
  };
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let latestInput = "";

async function suggestFor(
  text: string,
  suggest: (results: chrome.omnibox.SuggestResult[]) => void,
): Promise<void> {
  if (text !== latestInput) return; // superseded by a newer keystroke
  try {
    const { hits } = await searchDocs(text, SUGGEST_K);
    if (text !== latestInput) return;
    suggest(hits.map(formatSuggestion));
  } catch (error) {
    console.warn("[omnibox] suggestion failed", error);
    suggest([]);
  }
}

async function openUrl(
  url: string,
  disposition: chrome.omnibox.OnInputEnteredDisposition,
): Promise<void> {
  if (disposition === "newForegroundTab") {
    await chrome.tabs.create({ url, active: true });
    return;
  }
  if (disposition === "newBackgroundTab") {
    await chrome.tabs.create({ url, active: false });
    return;
  }
  // currentTab: a service worker has no bound "current window", so update by
  // the active tab's id rather than relying on chrome.tabs.update({url}).
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await chrome.tabs.update(tab.id, { url });
  else await chrome.tabs.create({ url, active: true });
}

async function openEntered(
  text: string,
  disposition: chrome.omnibox.OnInputEnteredDisposition,
): Promise<void> {
  console.log(`[omnibox] entered "${text}" (${disposition})`);
  try {
    // A chosen suggestion hands back its `content` (a doc URL); a bare query
    // (Enter without selecting a suggestion) opens the top-ranked match.
    if (text.startsWith(DOC_BASE)) {
      await openUrl(text, disposition);
      return;
    }
    const { hits } = await searchDocs(text, 1);
    if (hits.length > 0) await openUrl(docUrl(hits[0]!.docId), disposition);
    else console.log("[omnibox] no match to open for", text);
  } catch (error) {
    console.warn("[omnibox] open failed", error);
  }
}

export function registerOmnibox(): void {
  chrome.omnibox.onInputChanged.addListener((text, suggest) => {
    console.log(`[omnibox] changed "${text}"`);
    latestInput = text;
    chrome.omnibox.setDefaultSuggestion({
      description: `Open the top match for “<match>${xmlEscape(text)}</match>”`,
    });
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void suggestFor(text, suggest), DEBOUNCE_MS);
  });

  chrome.omnibox.onInputEntered.addListener((text, disposition) => {
    void openEntered(text, disposition);
  });
}
