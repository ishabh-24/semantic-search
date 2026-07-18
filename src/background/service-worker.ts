import type { Request, Response } from "../shared/messages";

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

chrome.runtime.onMessage.addListener(
  (request: Request, _sender, sendResponse: (response: Response) => void) => {
    if (request.type === "ping") {
      sendResponse({ type: "pong", startedAt });
    }
  },
);
