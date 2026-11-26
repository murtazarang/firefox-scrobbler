# Deploy Stream Scrobbler

This is a Worker and one D1 database, not a Pages app. The Firefox build on this branch targets `https://stream-scrobbler.murtaza2142.workers.dev`. Keep the existing `stream-scrobbler` placeholder and its Worker-level **All traffic** Access policy during initial deployment. No custom domain or GitHub integration is needed.

## One-time Cloudflare setup

1. In Cloudflare, verify the existing `stream-scrobbler` Worker is protected by **All traffic** Access. In **Manage Account → Account API Tokens**, create a short-lived custom token with only:
   - **Individual Workers → Editor**, for `stream-scrobbler` only.
   - **D1 → Edit** (also called **D1 Write**) for this Cloudflare account, to create the database and apply its migration.

   Do not authorize Wrangler's browser OAuth or grant DNS, Billing, Cache, Access, or other Developer Platform permissions. Save your account ID (the 32-character ID in the dashboard URL) and have the [Last.fm application key and its shared secret](https://www.last.fm/api/accounts) ready. No production values go in GitHub or chat.

2. In an interactive Bash terminal with **Node.js 24+ and npm**, run this from the repository root:

   ```bash
   bash worker/setup.sh
   ```

   The script asks for the account ID and scoped token (hidden), checks the existing Worker, and asks for confirmation before making changes. It reuses or creates the `stream-scrobbler` D1 database, applies pending migrations, prompts for missing Last.fm credentials without echoing them, generates a session-encryption key if needed, and deploys to the existing Worker. It preserves existing secrets and never silently replaces an encryption key for a database with saved sessions. It stages configuration and any new secrets in a private temporary directory and removes it on exit; it does not modify the checkout. **All traffic** Access remains in place. If a setup step fails after creating D1, rerun setup rather than creating another database.

3. Open [the Worker health endpoint](https://stream-scrobbler.murtaza2142.workers.dev/health) and sign in through Cloudflare Access. Expect `{"ok":true}`. This checks reachability, not D1 or Last.fm authorization. Revoke the setup token in Cloudflare once finished; it is not needed at runtime. If you manually manage the Worker secrets later, do not rotate `SESSION_ENCRYPTION_KEY` casually: the current sessions need the original key to be readable.

[Granular Wrangler access](https://developers.cloudflare.com/workers/authorization/#use-granular-permissions-with-wrangler) · [Account token setup](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/) · [D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/) · [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [Worker Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

## Verification and release

- Run `npm test` from the repo root before deploying. Mock tests cover two accounts, secret handling, single-use connection attempts, disconnect, and API failures. No tests send a real scrobble.
- Cloudflare Access's interactive login intentionally does not run in the Firefox background client. **All traffic** will block the real extension; don't embed a Cloudflare service token as a workaround. For a live test after app authentication is reviewed and you approve exposure, remove Access from the production URL (or use **Previews only**). This exposes the production API to the internet even if the add-on is unlisted. Preview URLs are disabled in the config. Test two connected accounts, VJRadio Load plays, a mapped Twitch scrobble, and disconnect before listing. The health endpoint and rate-limited auth handshakes are public; reads and writes require a valid per-install token.
- Before opening the service to the public, confirm permissible profile copying and muted/idle Twitch mirroring, and confirm quota, with Last.fm. Pro on the key owner is not blanket permission. Update the AMO privacy disclosure using the repo's privacy section and supply reviewer test instructions. [Last.fm API terms](https://www.last.fm/api/tos) · [Scrobbling guidance](https://www.last.fm/api/scrobbling) · [Mozilla add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
- The default rate limits are approximate and local to each Cloudflare location, not a hard global Last.fm quota. Set an appropriate quota strategy before inviting wide usage if Last.fm requires a hard limit. If you need to stop public traffic, restore **All traffic** Access for this Worker. [Cloudflare rate-limit behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
