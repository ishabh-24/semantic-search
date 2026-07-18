import type { Request, Response } from "../shared/messages";
import { AuthRequiredError, getAuthStatus, signIn } from "./auth";
import { listAllDocs } from "./drive";

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
