# Deploy Stream Scrobbler

This is a Worker and one D1 database, not a Pages app. The Firefox build on this branch targets `https://stream-scrobbler.murtaza2142.workers.dev`. Keep the existing `stream-scrobbler` placeholder and its Worker-level **All traffic** Access policy during initial deployment. No custom domain or GitHub integration is needed.

## 1. Protect the production Worker during setup

Use **All traffic** with **Cloudflare account members → Allow** on this Worker only. If those settings are already saved, skip to [step 2](#2-create-one-deployment-token-with-two-policies).

1. In the Cloudflare dashboard sidebar, go to **Build → Compute → Workers & Pages**.
2. Select **stream-scrobbler** in the application list.
3. Click **Access** in the Worker's top tab bar, immediately left of **Settings**. Do not use **Protect all Workers** on the overview page.
4. For a Worker that is not yet protected, click **Protect this Worker behind Access**. For a Worker that already has its own Access policy, open **Edit Worker access** to verify it; do not add a duplicate.
5. Under **Scope**, select **All traffic**. **Previews only** does not protect the production URL.
6. Under **Authentication policy**, select **Cloudflare account** if the rule is missing. The resulting rule is **Cloudflare account members** with **Allow**. Leave **Session duration** at its default; the existing setup shows **6 hours**.
7. Click **Apply Access** for new protection, or **Save changes** if you edited an existing policy. If you only inspected an existing policy and made no changes, click **Cancel**.

[Cloudflare's Worker Access guide and screenshots](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-one-worker)

## 2. Create one deployment token with two policies

The Worker Access policy controls browser sign-in. This account API token is a separate credential for the setup script. If you already have a token with both policies below, skip to [step 3](#3-run-the-installer).

1. Return to **Workers & Pages → stream-scrobbler** and click the **Settings** tab.
2. In Settings, click **Builds** in the right-hand menu.
3. In **API token for external CI/CD**, click **Create token**. This opens **Account API tokens → Create a token**. If you already have that form open, start at the next step. If you reached it via the [Account API tokens page](https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fapi-tokens) and there is no policy block yet, choose **Start from scratch**.
4. In **Token name**, enter `stream-scrobbler-setup`.
5. In the first **Edit policy** block, set the scope to **Specified Workers**.
6. Open **Select Workers…** and select only `stream-scrobbler`. Placeholder text alone does not select a Worker.
7. Under **Developer Platform → Individual Workers**, check only **Editor**.
8. Click **+ Add policy** below the first block. It adds a second policy to the same token. If Cloudflare opens a template picker, choose **Start from scratch**.
9. Set the second block's scope to **Entire Account**.
10. Search for `D1` within the second block and select only its **Edit** permission, named **D1 Edit** in Cloudflare's reference. The first block must stay scoped to the one Worker. If the permission is missing, stop rather than selecting a broader template.
11. Under **Token expiration**, choose **7 days**. Leave **Client IP address filtering** blank.
12. Click **Review token** and verify only **Editor** for `stream-scrobbler` and **D1 Edit** for the current account. The second grant lets the installer create and migrate D1; the Worker-only shortcut does not grant it.
13. Click **Create Token** once and copy the token when shown. Keep it out of chat, GitHub, and screenshots.

Creating an account API token requires **Super Administrator** or **API Token Provisioning**. Do not run `wrangler login` as a substitute. [Scoped Worker permissions](https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/#create-a-scoped-api-token) · [D1 permission names](https://developers.cloudflare.com/fundamentals/api/reference/permissions/#account-permissions)

## 3. Run the installer

Use an interactive Bash terminal with **Node.js 24+ and npm**. From the checkout on `main`, run `git pull --ff-only` if you need to update an existing checkout. The account ID is the 32-character ID in the Cloudflare account dashboard URL. Have the application key and shared secret from the same [Last.fm API application](https://www.last.fm/api/accounts) ready.

1. From the repository root, run:

   ```bash
   bash worker/setup.sh
   ```

2. At **Cloudflare account ID**, enter the ID.
3. At **Scoped Cloudflare API token (hidden)**, paste your token and press Enter. Nothing echoes while you paste. The first two prompts are skipped if their corresponding environment variables are already set.
4. After the script checks access to the existing Worker, confirm **All traffic** is on by typing `deploy` at the confirmation prompt. Any other input stops setup without changing remote resources.
5. After the D1 lookup, enter `LASTFM_API_KEY` and `LASTFM_SHARED_SECRET` if prompted. These prompts are hidden; existing Worker secrets are retained. The script generates `SESSION_ENCRYPTION_KEY` if needed and will not replace a missing key if doing so would strand existing sessions.

The installer creates or reuses `stream-scrobbler` in D1, applies its migration, and deploys to the existing Worker. It removes its temporary staging files and does not edit the checkout, change Cloudflare Access, or publish the Firefox add-on. If a run fails after creating D1, correct the reported error and rerun the installer; do not create a second database or run the migration SQL manually.

## 4. Verify the private deployment

1. Open the [Worker health endpoint](https://stream-scrobbler.murtaza2142.workers.dev/health) in a browser.
2. Sign in through Cloudflare Access if prompted.
3. Confirm the response is `{"ok":true}`. This checks Worker reachability only, not D1 or Last.fm sign-in, reads, or scrobbles.
4. Revoke the setup token from **Account API tokens** once setup is finished. The running Worker does not use it.

Do not rotate `SESSION_ENCRYPTION_KEY` casually: existing sessions need the original secret. Keep **All traffic** on during private setup. See [verification and release](#verification-and-release) before changing that setting to test Firefox against the hosted Worker.

## Verification and release

- Run `npm test` from the repo root before deploying. Mock tests cover two accounts, secret handling, single-use connection attempts, disconnect, and API failures. No tests send a real scrobble.
- Cloudflare Access's interactive login intentionally does not run in the Firefox background client. **All traffic** will block the real extension; don't embed a Cloudflare service token as a workaround. For a live test after app authentication is reviewed and you approve exposure, remove Access from the production URL (or use **Previews only**). This exposes the production API to the internet even if the add-on is unlisted. Preview URLs are disabled in the config. Test two connected accounts, VJRadio Load plays, a mapped Twitch scrobble, and disconnect before listing. The health endpoint and rate-limited auth handshakes are public; reads and writes require a valid per-install token.
- Before opening the service to the public, confirm permissible profile copying and muted/idle Twitch mirroring, and confirm quota, with Last.fm. Pro on the key owner is not blanket permission. Update the AMO privacy disclosure using the repo's privacy section and supply reviewer test instructions. [Last.fm API terms](https://www.last.fm/api/tos) · [Scrobbling guidance](https://www.last.fm/api/scrobbling) · [Mozilla add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
- The default rate limits are approximate and local to each Cloudflare location, not a hard global Last.fm quota. Set an appropriate quota strategy before inviting wide usage if Last.fm requires a hard limit. If you need to stop public traffic, restore **All traffic** Access for this Worker. [Cloudflare rate-limit behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
