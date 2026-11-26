# Stream Scrobbler

A desktop Firefox extension for three separate ways to scrobble to your Last.fm account. Targets desktop Firefox, including the November 2026 release. There is no explicit minimum Firefox version in the manifest. Audio recognition uses standard media-element capture when available, falls back to Firefox’s older prefixed method, and still requires Firefox’s audio-sharing consent control.

| Action | When it runs | What it uses |
| --- | --- | --- |
| Copy Last.fm plays | After you choose a profile, select plays and click **Scrobble selected** | The source profile's public Recent Tracks feed |
| Twitch mirroring | In the background while a mapped channel page is open | The paired Last.fm profile's new completed plays; Twitch tab focus, mute, pause, and playback state do not matter |
| Identify this tab | Only on click: **Identify this tab** previews a match; **Identify & scrobble** submits it directly | A short clip of the active tab's media player, sent to AudD |

## Try the extension

1. Clone or download this repo. In Firefox, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `extension/manifest.json`.
2. Open the toolbar popup and click **Settings**. Open [My Last.fm API accounts](https://www.last.fm/api/accounts) and select your app or [register a new API application](https://www.last.fm/api/account/create). Copy the API key and shared secret from the same application page into Settings, then click **Connect Last.fm** to save them and open Last.fm for approval. The shared secret is not your Last.fm password.
3. Approve access on Last.fm, return to Settings, and click **Finish connecting**. Last.fm can reuse its own website login if you already signed in; the extension never reads cookies or asks for your password. **Disconnect** clears the local session; you can revoke the authorization separately in Last.fm's account settings.
4. Add the Last.fm profile links and set a history limit (1–1,000 completed plays; Now Playing is displayed separately). To mirror a Twitch channel, add its exact channel URL and its matching Last.fm profile, enable the mapping and save. Firefox asks for Twitch host access when you enable your first mapping.
5. For recognition, save your own [AudD token](https://dashboard.audd.io/). In the Settings tab, click **Allow AudD access**, then **Allow audio sharing**. When Settings says **Ready**, return to the media tab. Start a media player in the active tab, then click **Identify this tab** and keep the popup open during the capture. Use **Scrobble match** after previewing, or click **Identify & scrobble** from the start to submit the first match without a separate confirmation. Keep the popup open until it reports the result. AudD has a trial, not an unlimited free plan.

Temporary installation lasts until Firefox restarts. For a permanent install on Firefox Release, submit the extension for Mozilla signing; a locally packed ZIP or XPI is unsigned. No add-on has been submitted to Mozilla or published on AMO.

## Behavior and limits

- Manual copying makes no write until you submit the selection. Historical plays retain their timestamps; the extension skips entries older than 14 days rather than dating them today. Last.fm applies its own rules and can reject individual entries or limit daily submissions. A manual **Now Playing** copy uses the time you submit it; the feed does not supply a historical timestamp for that entry.
- Twitch mappings start when a matching channel page is open. The add-on checks for new completed plays about once a minute, stops after the last matching tab closes or navigates away, and does not backfill plays from before that window. Only exact Twitch channel pages match, not VOD or clip URLs. Multiple tabs mapped to the same source share one mirror. No listening-time check or audio recognition runs in mirroring mode. Last.fm positions scrobbling as a record of your own listening; mirrored entries can affect your charts.
- An extension-local ledger prevents repeated submissions of the same artist/title/timestamp to the same destination. After a lost or ambiguous response, check your Last.fm history before attempting a manual correction. The ledger is not a scan of your entire destination history and cannot prevent duplicates submitted by other apps.
- Recognition uses Firefox's media-element capture, not microphone, system audio, or Chrome's tab capture API. It targets a playing HTML audio/video element in the top-level page. Protected, embedded, or nonstandard players may not expose usable audio; no generic bypass is attempted. Recognition is not proof that a play has met Last.fm's listening-duration guidance.
- Keys, settings, status and the short-lived duplicate ledger stay in extension-local storage, not Firefox Sync. Only the data needed for the Last.fm API goes to Last.fm; an on-demand recognition request sends the clip and your token to AudD, without the tab URL. The extension does not retain the clip on disk. No analytics.

## Development

Run `npm test` with a recent Node.js. No install is needed for the unit and mocked API tests. To create an unsigned build, use `npx web-ext build --source-dir extension`. To use the real providers you need your own credentials.

References: [Last.fm authorization](https://www.last.fm/api/desktopauth) · [Recent Tracks](https://www.last.fm/api/show/user.getRecentTracks) · [Scrobble endpoint](https://www.last.fm/api/show/track.scrobble) · [Mozilla Firefox data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) · [media element capture](https://developer.mozilla.org/docs/Web/API/HTMLMediaElement/captureStream) · [AudD](https://docs.audd.io/)

To run the Firefox smoke test with an isolated browser profile: `FIREFOX=/path/to/firefox GECKODRIVER=/path/to/geckodriver python3 test/firefox_smoke.py`. This temporarily loads the packaged extension, saves and reads settings, and exercises the capture function with a synthetic tone. It does not contact Last.fm, Twitch, YouTube, or AudD.
