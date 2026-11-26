# Deploy Stream Scrobbler

This is a Worker and one D1 database, not a Pages app. The Firefox build on this branch targets `https://stream-scrobbler.murtaza2142.workers.dev`. Keep the existing `stream-scrobbler` placeholder and its Worker-level **All traffic** Access policy during initial deployment. No custom domain or GitHub integration is needed.

## One-time Cloudflare setup

From this directory, using a current Node.js and Wrangler:

```sh
npx wrangler login
npx wrangler d1 create stream-scrobbler
```

Use the Cloudflare account that owns the existing Worker. Run `d1 create` only once. If Wrangler offers to edit your config, keep the provided `wrangler.jsonc` and replace only `REPLACE_WITH_D1_DATABASE_ID` with the database ID from the command output. The database ID is not a secret. No production database ID is included here.

```sh
npx wrangler d1 migrations apply stream-scrobbler --remote
```

In your existing Worker's **Settings → Variables and Secrets**, add these as type **Secret** and save/deploy the settings:

| Name | Value |
| --- | --- |
| `LASTFM_API_KEY` | Dedicated [Last.fm application key](https://www.last.fm/api/accounts) |
| `LASTFM_SHARED_SECRET` | Shared secret from the same Last.fm application |
| `SESSION_ENCRYPTION_KEY` | A base64-encoded 32-byte random key, generated locally with `openssl rand -base64 32` |

Keep the encryption key in your password manager. Replacing it without a migration makes existing sessions unreadable, so it requires clearing those sessions and reconnecting. Never paste real values into source, terminal arguments, GitHub, or chat. The app key is visible in Last.fm's authorization URL by design; the shared secret stays with the Worker.

From this directory, deploy **to the existing Worker**, then open its `/health` URL in a normal browser and complete your Cloudflare Access sign-in. It should return `{"ok":true}`. This verifies the Worker responds, not that D1 or Last.fm authentication works.

```sh
npx wrangler deploy
```

[Cloudflare D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/) · [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [Deploy a Worker](https://developers.cloudflare.com/workers/get-started/guide/) · [Worker Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)

## Verification and release

- Run `npm test` from the repo root before deploying. Mock tests cover two accounts, secret handling, single-use connection attempts, disconnect, and API failures. No tests send a real scrobble.
- Cloudflare Access's interactive login intentionally does not run in the Firefox background client. **All traffic** will block the real extension; don't embed a Cloudflare service token as a workaround. For a live test after app authentication is reviewed and you approve exposure, remove Access from the production URL (or use **Previews only**). This exposes the production API to the internet even if the add-on is unlisted. Preview URLs are disabled in the config. Test two connected accounts, VJRadio Load plays, a mapped Twitch scrobble, and disconnect before listing. The health endpoint and rate-limited auth handshakes are public; reads and writes require a valid per-install token.
- Before opening the service to the public, confirm permissible profile copying and muted/idle Twitch mirroring, and confirm quota, with Last.fm. Pro on the key owner is not blanket permission. Update the AMO privacy disclosure using the repo's privacy section and supply reviewer test instructions. [Last.fm API terms](https://www.last.fm/api/tos) · [Scrobbling guidance](https://www.last.fm/api/scrobbling) · [Mozilla add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
- The default rate limits are approximate and local to each Cloudflare location, not a hard global Last.fm quota. Set an appropriate quota strategy before inviting wide usage if Last.fm requires a hard limit. If you need to stop public traffic, restore **All traffic** Access for this Worker. [Cloudflare rate-limit behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
