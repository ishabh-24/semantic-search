# One-time OAuth setup (Google Cloud Console)

`chrome.identity.getAuthToken` needs an OAuth client ID of type **Chrome
Extension** registered against this extension's ID. The extension ID is
stable — `inmnnnhimebkhjnplecanmapdlcndalm` — because the manifest pins the
public key (`key` field). The matching private key lives in `key.pem`
(gitignored); it is only needed if you ever pack a `.crx` manually.

## Steps

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   create a project (e.g. `drive-semantic-search`).
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen**:
   - Audience: **External**, then add your own Google account under
     **Test users**. (In testing mode, only test users can authorize —
     no Google verification review needed.)
   - Under **Data access / Scopes**, add:
     - `https://www.googleapis.com/auth/drive.readonly`
     - `https://www.googleapis.com/auth/drive.appdata`
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Chrome Extension**
   - Item ID: `inmnnnhimebkhjnplecanmapdlcndalm`
5. Copy the generated client ID (`…apps.googleusercontent.com`) into
   `public/manifest.json` → `oauth2.client_id`, then run `npm run build`
   and reload the extension.

## Verifying the revoked-token path (commit 2's "done when")

1. Connect via the popup button; confirm it shows your account email.
2. Go to [myaccount.google.com/connections](https://myaccount.google.com/connections),
   find the app, and remove its access.
3. Reopen the popup: it must show "Access to Google Drive was revoked.
   Reconnect to continue." — clicking Reconnect opens a fresh consent
   window. Silent success or a generic error here is a bug.
