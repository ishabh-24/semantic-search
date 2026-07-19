import type { Request, Response } from "../shared/messages";
import { AuthRequiredError, getAuthStatus, signIn } from "./auth";
import { exportDocs, listAllDocs } from "./drive";

// MV3 service workers are killed after ~30s of inactivity and restarted on
// demand. Top-level code runs on every (re)start, so this timestamp
// identifies the current worker instance in logs.
const startedAt = Date.now();
console.log(`[sw] started at ${new Date(startedAt).toISOString()}`);

const HEARTBEAT_ALARM = "heartbeat";

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[sw] onInstalled: ${details.reason}`);
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    console.log(`[sw] heartbeat (instance started ${new Date(startedAt).toISOString()})`);
  }
});

async function handle(request: Request): Promise<Response> {
  switch (request.type) {
    case "ping":
      return { type: "pong", startedAt };
    case "auth.getStatus":
      return { type: "auth.status", status: await getAuthStatus() };
    case "auth.signIn":
      return { type: "auth.status", status: await signIn() };
    case "drive.listDocs":
      return listDocs();
    case "drive.exportAll":
      return exportAll();
  }
}

async function exportAll(): Promise<Response> {
  try {
    const docs = await listAllDocs();
    console.log(`[drive] exporting ${docs.length} docs…`);
    const started = Date.now();
    const report = await exportDocs(docs, (done, total) => {
      if (done % 20 === 0 || done === total) console.log(`[drive] export ${done}/${total}`);
    });
    const totalChars = report.exported.reduce((sum, e) => sum + e.markdown.length, 0);
    const elapsedMs = Date.now() - started;
    console.log(
      `[drive] export finished: ${report.exported.length} ok, ` +
        `${report.failed.length} failed, ${totalChars} chars, ${Math.round(elapsedMs / 1000)}s`,
    );
    if (report.failed.length > 0) console.table(report.failed.map((f) => ({ name: f.doc.name, error: f.error })));
    return {
      type: "drive.exportReport",
      ok: true,
      exported: report.exported.length,
      failed: report.failed.length,
      totalChars,
      elapsedMs,
      failureSample: report.failed.slice(0, 3).map((f) => ({ name: f.doc.name, error: f.error })),
    };
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return { type: "drive.exportReport", ok: false, error: "Not connected to Google Drive." };
    }
    console.error("[drive] export run failed", error);
    return { type: "drive.exportReport", ok: false, error: String(error) };
  }
}

async function listDocs(): Promise<Response> {
  try {
    const docs = await listAllDocs();
    console.log(`[drive] inventory: ${docs.length} Google Docs`);
    console.table(docs);
    return {
      type: "drive.docList",
      ok: true,
      count: docs.length,
      sample: docs.slice(0, 5).map((d) => d.name),
    };
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return { type: "drive.docList", ok: false, error: "Not connected to Google Drive." };
    }
    console.error("[drive] files.list failed", error);
    return { type: "drive.docList", ok: false, error: String(error) };
  }
}

chrome.runtime.onMessage.addListener((request: Request, _sender, sendResponse) => {
  handle(request).then(sendResponse, (error) => {
    console.error("[sw] handler failed", request.type, error);
    sendResponse({
      type: "auth.status",
      status: { state: "disconnected", reason: "error", detail: String(error) },
    } satisfies Response);
  });
  // Keep the message channel open for the async response.
  return true;
});
