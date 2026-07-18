import type { AuthStatus, DisconnectedReason } from "../shared/messages";

// Auth via chrome.identity.getAuthToken: Chrome owns the token lifecycle
// (grant storage, refresh, consent UI) for the browser's Google account, so
// we never persist tokens ourselves. The one gap we must cover is
// revocation — Chrome keeps serving a cached access token even after the
// user revokes the grant at myaccount.google.com, so we validate against
// Google's tokeninfo endpoint and evict the cache when it fails.

const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

type TokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: DisconnectedReason; detail?: string };

async function requestToken(interactive: boolean): Promise<TokenResult> {
  try {
    const { token } = await chrome.identity.getAuthToken({ interactive });
    if (!token) return { ok: false, reason: "never_connected" };
    return { ok: true, token };
  } catch (error) {
    return classifyIdentityError(String(error));
  }
}

// chrome.identity surfaces failures only as human-readable strings, so
// classification is substring matching against the known messages.
function classifyIdentityError(message: string): TokenResult {
  const m = message.toLowerCase();
  if (m.includes("not signed in") || m.includes("user is not signed in")) {
    return { ok: false, reason: "chrome_signed_out" };
  }
  if (m.includes("did not approve")) {
    return { ok: false, reason: "declined" };
  }
  if (m.includes("bad client id") || m.includes("invalid oauth2 client id")) {
    return { ok: false, reason: "config", detail: message };
  }
  if (m.includes("not granted or revoked")) {
    // Non-interactive request with no usable grant. Without a previously
    // cached token we cannot tell "never connected" from "revoked" here;
    // getAuthStatus() upgrades this to "revoked" when it has the evidence.
    return { ok: false, reason: "never_connected" };
  }
  return { ok: false, reason: "error", detail: message };
}

/** True if Google accepts the token, false if Google rejects it.
 *  Throws on network failure — offline must never read as "revoked". */
async function isTokenValid(token: string): Promise<boolean> {
  const res = await fetch(`${TOKENINFO_URL}?access_token=${encodeURIComponent(token)}`);
  if (res.ok) return true;
  if (res.status === 400 || res.status === 401) return false;
  throw new Error(`tokeninfo returned ${res.status}`);
}

async function profileEmail(): Promise<string | null> {
  try {
    const info = await chrome.identity.getProfileUserInfo({
      accountStatus: chrome.identity.AccountStatus.ANY,
    });
    return info.email || null;
  } catch {
    return null;
  }
}

/** Thrown by getApiToken when no usable grant exists; callers surface
 *  the popup's connect flow rather than handling this inline. */
export class AuthRequiredError extends Error {
  constructor(public readonly reason: DisconnectedReason) {
    super(`auth required: ${reason}`);
    this.name = "AuthRequiredError";
  }
}

/** Silent token for API calls. Skips tokeninfo validation — API callers
 *  learn about revocation from a 401 and call invalidateCachedToken. */
export async function getApiToken(): Promise<string> {
  const result = await requestToken(false);
  if (!result.ok) throw new AuthRequiredError(result.reason);
  return result.token;
}

export async function invalidateCachedToken(token: string): Promise<void> {
  await chrome.identity.removeCachedAuthToken({ token });
}

/** Silent status check: never opens a consent window. */
export async function getAuthStatus(): Promise<AuthStatus> {
  const cached = await requestToken(false);
  if (!cached.ok) {
    return { state: "disconnected", reason: cached.reason, detail: cached.detail };
  }

  let valid: boolean;
  try {
    valid = await isTokenValid(cached.token);
  } catch {
    // Offline: we hold a token and cannot disprove it. Report connected;
    // actual API calls will surface their own errors (commit 18's territory).
    return { state: "connected", email: await profileEmail() };
  }
  if (valid) {
    return { state: "connected", email: await profileEmail() };
  }

  // Google rejected the cached token. Evict it and let Chrome try to mint
  // a fresh one from the underlying grant — that distinguishes a merely
  // expired token (refresh succeeds) from a revoked grant (refresh fails).
  await chrome.identity.removeCachedAuthToken({ token: cached.token });
  const retry = await requestToken(false);
  if (retry.ok) {
    try {
      if (await isTokenValid(retry.token)) {
        return { state: "connected", email: await profileEmail() };
      }
    } catch {
      return { state: "connected", email: await profileEmail() };
    }
    await chrome.identity.removeCachedAuthToken({ token: retry.token });
  }
  return { state: "disconnected", reason: "revoked" };
}

/** Interactive sign-in: opens the consent window if needed. */
export async function signIn(): Promise<AuthStatus> {
  const result = await requestToken(true);
  if (!result.ok) {
    return { state: "disconnected", reason: result.reason, detail: result.detail };
  }
  return { state: "connected", email: await profileEmail() };
}
