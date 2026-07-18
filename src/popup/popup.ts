import { sendRequest } from "../shared/messages";

const status = document.getElementById("status")!;

// Opening the popup wakes the service worker if Chrome has killed it; the
// pong's startedAt shows whether we're talking to a fresh or warm instance.
try {
  const response = await sendRequest({ type: "ping" });
  status.textContent = `Service worker alive (instance started ${new Date(
    response.startedAt,
  ).toLocaleTimeString()})`;
} catch (error) {
  status.textContent = `Service worker unreachable: ${String(error)}`;
}
