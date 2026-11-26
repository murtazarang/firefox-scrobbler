# Stream Scrobbler

A desktop Firefox extension for three separate ways to scrobble to your Last.fm account. Targets desktop Firefox, including the November 2026 release. There is no explicit minimum Firefox version in the manifest. Audio recognition uses standard media-element capture when available, falls back to Firefox’s older prefixed method, and still requires Firefox’s audio-sharing consent control.

| Action | When it runs | What it uses |
| --- | --- | --- |
| Copy Last.fm plays | After you preview plays and click **Scrobble all** or **Scrobble selected** | The source profile's public Recent Tracks feed |
| Twitch mirroring | In the background while a mapped channel page is open | The paired Last.fm profile's new completed plays; Twitch tab focus, mute, pause, and playback state do not matter |
| Identify this tab | Only on click: **Identify this tab** previews a match; **Identify & scrobble** submits it directly | A short clip of the active tab's media player, sent to AudD |

## Try the extension

1. Clone or download this repo. In Firefox, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `extension/manifest.json`.
2. Open the toolbar popup, select **Set up Last.fm**, and click **Connect Last.fm**. Approve the app on Last.fm, return to Settings, then click **Finish connecting**. You don't need an API key, a Pro subscription, or a Cloudflare account. The extension never reads your Last.fm cookies or asks for your password.
3. **Disconnect** removes this installation's stored connection from the service. You can independently revoke Stream Scrobbler in [Last.fm's connected-app settings](https://www.last.fm/settings/applications). If you're upgrading from 0.1, reconnect once. Old Last.fm API credentials and the old session are removed locally; profile lists, mappings and AudD preferences are kept.
4. Add the Last.fm profile links and set a history limit (1–1,000 completed plays; Now Playing is displayed separately). To mirror a Twitch channel, add its exact channel URL and its matching Last.fm profile, enable the mapping and save. Firefox asks for Twitch host access when you enable your first mapping.
5. For recognition, save your own [AudD token](https://dashboard.audd.io/). In the Settings tab, click **Allow AudD access**, then **Allow audio sharing**. When Settings says **Ready**, return to the media tab. Start a media player in the active tab, then click **Identify this tab** and keep the popup open during the capture. Use **Scrobble match** after previewing, or click **Identify & scrobble** from the start to submit the first match without a separate confirmation. Keep the popup open until it reports the result. AudD has a trial, not an unlimited free plan.

Temporary installation lasts until Firefox restarts. For a permanent install on Firefox Release, submit the extension for Mozilla signing; a locally packed ZIP or XPI is unsigned. This branch is the Cloudflare-backed 0.2 development version; it requires a deployed backend. The [0.1 branch](https://github.com/murtazarang/firefox-scrobbler/tree/0.1) retains the original bring-your-own-key build.

## Behavior and limits

- If Load plays fails, expand **Paste plays**. Copy the English Last.fm Recent Tracks table directly, without reformatting. Relative times such as “4 hours ago” are estimates relative to when you paste; same-track plays that share an estimated timestamp can be skipped as duplicates. For exact times, paste or enter one play per line as `Artist | Track | Timestamp` (or tab-separated). Use the original timestamp as Unix seconds or an ISO date and time with a timezone, for example `2026-11-25T14:00:00Z`. Click **Preview pasted plays** to check the count, expand the list if you want to review it, then click **Scrobble all**. No profile page is scraped.
- Manual copying makes no write until you submit the selection. Historical plays retain their timestamps; the extension skips entries older than 14 days rather than dating them today. Last.fm applies its own rules and can reject individual entries or limit daily submissions. A manual **Now Playing** copy uses the time you submit it; the feed does not supply a historical timestamp for that entry.
- Twitch mappings start when a matching channel page is open. The add-on checks for new completed plays about once a minute, stops after the last matching tab closes or navigates away, and does not backfill plays from before that window. Only exact Twitch channel pages match, not VOD or clip URLs. Multiple tabs mapped to the same source share one mirror. No listening-time check or audio recognition runs in mirroring mode. Last.fm positions scrobbling as a record of your own listening; mirrored entries can affect your charts.
- An extension-local ledger prevents repeated submissions of the same artist/title/timestamp to the same destination. After a lost or ambiguous response, check your Last.fm history before attempting a manual correction. The ledger is not a scan of your entire destination history and cannot prevent duplicates submitted by other apps.
- Recognition uses Firefox's media-element capture, not microphone, system audio, or Chrome's tab capture API. It targets a playing HTML audio/video element in the top-level page. Protected, embedded, or nonstandard players may not expose usable audio; no generic bypass is attempted. Recognition is not proof that a play has met Last.fm's listening-duration guidance.
- If Last.fm's recent-tracks API is unavailable, Cloudflare cannot repair it. Manual reads show the error and point to Paste plays; automatic reads back off. Ambiguous writes are not blindly retried.

## Privacy

Firefox stores your settings, a revocable app credential and a short-lived duplicate ledger locally, not in Firefox Sync. The Stream Scrobbler Worker on Cloudflare handles Last.fm authorization, receives source usernames and query parameters to fetch recent tracks, and forwards track details and timestamps to Last.fm when you submit or enable a Twitch mapping. Cloudflare also sees the request IP as the host; the Worker uses it to rate-limit login attempts. D1 keeps your Last.fm account name, an encrypted Last.fm session key, and a hash of the app credential until you disconnect or the service detects that Last.fm revoked the session. Short-lived connection attempts expire after ten minutes and are cleaned up on a later connection request. The app does not store your listening history, Twitch tab URLs, or audio server-side, or collect analytics. Cloudflare and Last.fm have their own service policies.

On-demand recognition sends a short clip and your own token directly to AudD, without the tab URL. The audio does not go to Stream Scrobbler's Worker and the extension does not retain the clip on disk. If you submit the match, only the track metadata and timestamp go through the Worker.

For the account-owner setup, see [Deploy the Worker](worker/README.md).

## Development

Run `npm test` with Node.js 24 or later. No install is needed for the unit, SQLite-backed, and mocked API tests. To create an unsigned build, use `npx web-ext build --source-dir extension`. Live Last.fm requests require the account owner to deploy and configure the Worker; live recognition requires your own AudD token.

References: [Last.fm authorization](https://www.last.fm/api/desktopauth) · [Recent Tracks](https://www.last.fm/api/show/user.getRecentTracks) · [Scrobble endpoint](https://www.last.fm/api/show/track.scrobble) · [Mozilla Firefox data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) · [media element capture](https://developer.mozilla.org/docs/Web/API/HTMLMediaElement/captureStream) · [AudD](https://docs.audd.io/)

To run the Firefox smoke test with an isolated browser profile: `FIREFOX=/path/to/firefox GECKODRIVER=/path/to/geckodriver python3 test/firefox_smoke.py`. This temporarily loads the packaged extension, saves and reads settings, and exercises the capture function with a synthetic tone. It does not contact Last.fm, Twitch, YouTube, or AudD.
