import { sendRequest, type AuthStatus } from "../shared/messages";

const status = document.getElementById("status")!;
const connectButton = document.getElementById("connect") as HTMLButtonElement;
const query = document.getElementById("query") as HTMLInputElement;
const listDocsButton = document.getElementById("list-docs") as HTMLButtonElement;
const devResult = document.getElementById("dev-result")!;

function render(auth: AuthStatus): void {
  connectButton.hidden = auth.state === "connected";
  listDocsButton.hidden = auth.state !== "connected";
  query.disabled = true; // search arrives in commit 13

  if (auth.state === "connected") {
    status.textContent = auth.email
      ? `Connected to Google Drive as ${auth.email}`
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
        "OAuth client ID is missing or invalid — set it in manifest.json (see docs/oauth-setup.md).";
      connectButton.hidden = true;
      break;
    default:
      status.textContent = `Something went wrong: ${auth.detail ?? "unknown error"}`;
      connectButton.textContent = "Retry";
  }
}

async function refresh(request: { type: "auth.getStatus" } | { type: "auth.signIn" }) {
  const response = await sendRequest(request);
  if (response.type === "auth.status") render(response.status);
}

connectButton.addEventListener("click", () => {
  status.textContent = "Waiting for Google consent…";
  connectButton.disabled = true;
  refresh({ type: "auth.signIn" }).finally(() => {
    connectButton.disabled = false;
  });
});

listDocsButton.addEventListener("click", async () => {
  listDocsButton.disabled = true;
  devResult.hidden = false;
  devResult.textContent = "Listing docs…";
  try {
    const response = await sendRequest({ type: "drive.listDocs" });
    if (response.type !== "drive.docList") return;
    devResult.textContent = response.ok
      ? `${response.count} Google Docs found (full inventory in the SW console). ` +
        `Newest: ${response.sample.join(" · ")}`
      : response.error;
  } finally {
    listDocsButton.disabled = false;
  }
});

await refresh({ type: "auth.getStatus" });
