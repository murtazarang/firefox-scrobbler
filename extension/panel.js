"use strict";

const $ = id => document.getElementById(id);
const settings = new URLSearchParams(location.search).has("settings");
const TWITCH = ["https://www.twitch.tv/*","https://twitch.tv/*"];
const AUDD = {origins:["https://api.audd.io/*"]};
const CLIP = {data_collection:["websiteContent"]};
let state, previewRows = [], previewSource = "", match;
const note = message => { $("status").textContent = message; };
const profileUrl = user => "https://www.last.fm/user/" + encodeURIComponent(user);
const twitchUrl = channel => "https://www.twitch.tv/" + encodeURIComponent(channel);
async function call(action, args = {}) {
  const reply = await browser.runtime.sendMessage({action,...args});
  if (reply?.error) throw Error(reply.error);
  return reply?.data;
}
function bind(id, fn) {
  $(id).addEventListener("click", async () => {
    $(id).disabled = true;
    note("");
    try { await fn(); } catch (error) { note(error.message); }
    finally { $(id).disabled = false; }
  });
}
function line(parent, text, tag = "p") {
  const el = document.createElement(tag);
  el.textContent = text;
  parent.append(el);
  return el;
}
function printReport(r) {
  note(`Submitted: ${r.accepted}. Skipped: ${r.skipped}. Rejected: ${r.rejected}. Unconfirmed: ${r.uncertain}.` +
    (r.codes.length ? " Last.fm rejection codes: " + r.codes.join(", ") + "." : "") +
    (r.error ? " " + r.error : "") +
    (r.uncertain ? " Check your Last.fm history before trying again." : ""));
}
function mappingRow(m = {enabled:true}) {
  const box = document.createElement("fieldset");
  line(box,"Twitch mapping","legend");
  const input = (caption, attr, value, placeholder) => {
    const label = document.createElement("label");
    const f = document.createElement("input");
    f.type = "url";
    f.dataset.field = attr;
    f.value = value;
    f.placeholder = placeholder;
    label.append(caption, f);
    box.append(label);
  };
  input("Twitch channel link","channel",m.channel ? twitchUrl(m.channel) : "", "https://www.twitch.tv/channel");
  input("Last.fm profile link","profile",m.profile ? profileUrl(m.profile) : "", "https://www.last.fm/user/name");
  const label = document.createElement("label");
  label.className = "check";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.checked = m.enabled;
  label.append(check,"Mirror while Twitch tab is open");
  box.append(label);
  const remove = line(box,"Remove mapping","button");
  remove.addEventListener("click",() => box.remove());
  $("mappings").append(box);
}
async function refresh() {
  state = await call("status");
  $("account").textContent = state.account ? "Connected as " + state.account : "Last.fm not connected";
  if (settings) {
    $("finish").hidden = !state.connecting;
    $("disconnect").hidden = !state.account && !state.connecting;
    $("apiKey").placeholder = state.config.hasKey ? "Saved" : "";
    $("secret").placeholder = state.config.hasKey ? "Saved" : "";
    $("auddToken").placeholder = state.config.hasRecognition ? "Saved" : "";
  } else {
    $("settings").textContent = state.account ? "Settings" : "Set up Last.fm";
    $("setupHint").hidden = Boolean(state.account);
    $("profile").replaceChildren(...state.config.profiles.map(user => new Option(user,user)));
    $("preview").disabled = !state.config.profiles.length;
    const {active, mirrorStatus: s} = state;
    $("mirror").textContent = active.length ? "Following: " + active.join(", ") : "No mapped channels open.";
    if (active.includes(s?.profile) && s.report.error) $("mirror").textContent += " " + s.report.error;
  }
}

async function capturePermissions() {
  const auddOrigin = await browser.permissions.contains(AUDD);
  let clipConsent;
  try { clipConsent = await browser.permissions.contains(CLIP); }
  catch { clipConsent = null; }
  return {auddOrigin, clipConsent};
}
async function updateRecognitionSettings() {
  const {auddOrigin,clipConsent} = await capturePermissions();
  const button = $("recognitionPermission");
  button.hidden = !state.config.hasRecognition || clipConsent === null || (auddOrigin && clipConsent);
  button.textContent = auddOrigin ? "Allow audio sharing" : "Allow AudD access";
  $("recognitionStatus").textContent = !state.config.hasRecognition ? "Save your AudD token to start setup."
    : clipConsent === null ? "This Firefox build doesn’t expose the audio-sharing consent control."
    : !auddOrigin ? "Step 1 of 2: Allow the extension to contact AudD."
    : !clipConsent ? "Step 2 of 2: Allow the extension to send a clip to AudD only when you click Identify this tab."
    : "Ready. Return to a playing tab and click Identify this tab.";
  return {auddOrigin,clipConsent};
}

function recordPlayer() {
  return new Promise(resolve => {
    const playing = [...document.querySelectorAll("video,audio")].filter(x => !x.paused && !x.ended && x.readyState >= 2);
    const player = playing.find(x => x.matches("video") && x.getBoundingClientRect().width > 0) || playing[0];
    if (!player) return resolve({error:"No playing audio or video element was found in this tab."});
    let source, recorder, timer, watchdog, finished = false;
    const chunks = [];
    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(watchdog);
      if (recorder?.state === "recording") recorder.stop();
      source?.getTracks().forEach(track => track.stop());
      resolve(result);
    }
    try {
      const capture = player.captureStream || player.mozCaptureStream;
      if (!capture) return finish({error:"This Firefox version cannot capture audio from media elements."});
      source = capture.call(player);
      const audio = source.getAudioTracks().filter(t => t.readyState === "live" && !t.muted);
      if (!audio.length) return finish({error:"This player has no capturable audio. It may be protected or embedded."});
      const mimeType = ["audio/webm;codecs=opus","audio/ogg;codecs=opus"]
        .find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) return finish({error:"Firefox has no supported Opus audio encoder."});
      recorder = new MediaRecorder(new MediaStream([audio[0]]), {mimeType});
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => finish({error:"Firefox couldn’t record audio from this player."});
      recorder.onstop = () => {
        const blob = new Blob(chunks,{type:chunks[0]?.type || mimeType});
        if (!blob.size || blob.size > 3000000) return finish({error:"The player produced no usable audio clip."});
        const reader = new FileReader();
        reader.onload = () => finish({data:String(reader.result).split(",")[1], type:blob.type});
        reader.onerror = () => finish({error:"Could not read the audio clip."});
        reader.readAsDataURL(blob);
      };
      recorder.start();
      timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); },10000);
      watchdog = setTimeout(() => finish({error:"Audio capture timed out."}),14000);
    } catch { finish({error:"This player doesn’t allow Firefox to capture its audio."}); }
  });
}

if (settings) {
  document.body.classList.add("options");
  $("options").hidden = false;
  $("settings").hidden = true;
  bind("addMapping", () => mappingRow());
  bind("save", async () => {
    const links = $("profiles").value.split("\n").map(x => x.trim()).filter(Boolean);
    const profiles = [...new Set(links.map(x => Scrobble.nameFromUrl(x,"lastfm")))];
    if (profiles.includes(null)) throw Error("Use full HTTPS Last.fm profile links.");
    const limit = $("limit").valueAsNumber;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw Error("Enter a history limit from 1 to 1000.");
    const mappings = [...$("mappings").querySelectorAll("fieldset")].map(box => ({
      channel: Scrobble.nameFromUrl(box.querySelector('[data-field=channel]').value.trim(),"twitch"),
      profile: Scrobble.nameFromUrl(box.querySelector('[data-field=profile]').value.trim(),"lastfm"),
      enabled: box.querySelector('[type=checkbox]').checked
    }));
    if (mappings.some(m => !m.channel || !m.profile)) throw Error("Every mapping needs a Twitch channel link and a Last.fm profile link.");
    if (new Set(mappings.map(m => m.channel)).size !== mappings.length) throw Error("Use one mapping per Twitch channel.");
    // Invoke permission requests straight from the click, before awaiting other operations.
    if (mappings.some(m => m.enabled) && !await browser.permissions.request({origins:TWITCH})) throw Error("Twitch access is needed for automatic mirroring.");
    const config = {profiles,limit,mappings};
    if ($("auddToken").value.trim()) config.auddToken = $("auddToken").value.trim();
    if ($("forgetAudD").checked) config.auddToken = "";
    await call("save",{config});
    $("auddToken").value = "";
    $("forgetAudD").checked = false;
    await refresh();
    await updateRecognitionSettings();
    note("Settings saved.");
  });
  bind("recognitionPermission", async () => {
    const clip = $("recognitionPermission").textContent === "Allow audio sharing";
    note("Waiting for Firefox’s permission prompt. Choose Allow to continue.");
    const allowed = await browser.permissions.request(clip ? CLIP : AUDD);
    await updateRecognitionSettings();
    note(allowed ? "" : "Permission wasn’t granted. You can try again here.");
  });
  bind("connect", async () => {
    const apiKey = $("apiKey").value.trim(), secret = $("secret").value.trim();
    if (Boolean(apiKey) !== Boolean(secret))
      throw Error("Paste both credentials from the same Last.fm API application.");
    await call("connect", {apiKey,secret});
    $("apiKey").value = "";
    $("secret").value = "";
    await refresh();
    note("Approve on Last.fm, then return here and click Finish connecting.");
  });
  bind("finish",async () => { const account = await call("finish"); await refresh(); note("Connected as " + account + "."); });
  bind("disconnect",async () => { await call("disconnect"); await refresh(); note("Disconnected. Revoke server-side access in Last.fm Settings → Applications if desired."); });
  refresh().then(() => {
    $("profiles").value = state.config.profiles.map(profileUrl).join("\n");
    $("limit").value = state.config.limit;
    state.config.mappings.forEach(mappingRow);
    return updateRecognitionSettings();
  }).catch(e => note(e.message));
} else {
  document.body.classList.add("popup");
  $("actions").hidden = false;
  bind("settings",() => browser.runtime.openOptionsPage());
  bind("recognitionSettings",() => browser.runtime.openOptionsPage());
  $("profile").addEventListener("change",() => {
    $("list").replaceChildren(); $("copy").hidden = true; previewRows = [];
  });
  bind("preview", async () => {
    const source = $("profile").value;
    const {current,history} = await call("preview",{profile:source});
    if ($("profile").value !== source) return;
    previewSource = source;
    previewRows = [...(current ? [current] : []), ...history];
    $("list").replaceChildren();
    $("copy").hidden = !previewRows.length;
    if (!previewRows.length) return note("No recent plays found.");
    previewRows.forEach((t,i) => {
      const label = document.createElement("label");
      label.className = "track";
      const check = document.createElement("input");
      check.type = "checkbox"; check.value = i;
      label.append(check);
      line(label,t.artist + " — " + t.title + (t.now ? " · Now playing (submitted with the current time)" : " · " + new Date(t.ts*1000).toLocaleString()),"span");
      $("list").append(label);
    });
  });
  bind("copy", async () => {
    const rows = [...$("list").querySelectorAll("input:checked")].map(x => previewRows[Number(x.value)]);
    if (!rows.length) throw Error("Select at least one play.");
    const report = await call("submit",{rows,source:previewSource});
    printReport(report);
  });
  bind("identify", async () => {
    $("match").replaceChildren(); $("scrobble").hidden = true; match = null;
    if (!state?.config.hasRecognition) {
      $("recognitionSettings").hidden = false;
      throw Error("Open Set up AudD, save your token, and grant both permissions in Settings.");
    }
    const {auddOrigin,clipConsent} = await capturePermissions();
    if (!auddOrigin || !clipConsent) {
      $("recognitionSettings").hidden = false;
      throw Error(clipConsent === null ? "This Firefox build doesn’t expose the audio-sharing consent control."
        : "Open Set up AudD and grant the missing permission in Settings.");
    }
    $("recognitionSettings").hidden = true;
    const [tab] = await browser.tabs.query({active:true,currentWindow:true});
    if (!tab?.id) throw Error("No active browser tab.");
    const started = Math.floor(Date.now()/1000);
    note("Listening for 10 seconds. Keep this popup open.");
    let frames;
    try { frames = await browser.scripting.executeScript({target:{tabId:tab.id},func:recordPlayer}); }
    catch { throw Error("Firefox cannot run audio capture on this tab."); }
    const clip = frames[0]?.result;
    if (!clip?.data) throw Error(clip?.error || "Firefox couldn’t capture audio on this page.");
    if (!await browser.permissions.contains(CLIP) || !await browser.permissions.contains(AUDD))
      throw Error("Capture permission was removed. The clip was not sent.");
    const {config} = await browser.storage.local.get("config");
    if (!config?.auddToken) throw Error("Your AudD token was removed. The clip was not sent.");
    const body = new FormData();
    const format = clip.type.includes("ogg") ? "ogg" : "webm";
    body.set("api_token",config.auddToken);
    body.set("file", new Blob([Uint8Array.from(atob(clip.data),x => x.charCodeAt(0))],{type:clip.type}),"sample."+format);
    const response = await fetch("https://api.audd.io/",{method:"POST",body,credentials:"omit",redirect:"error",signal:AbortSignal.timeout(20000)}).catch(() => { throw Error("Could not reach AudD."); });
    const x = await response.json().catch(() => null);
    if (!response.ok || x?.status !== "success") throw Error("AudD could not identify the clip. Check your token and quota.");
    if (!x.result?.artist || !x.result?.title) return note("No match found.");
    match = {artist:x.result.artist,title:x.result.title,album:x.result.album || "",ts:started};
    line($("match"),match.artist+" — "+match.title);
    $("scrobble").hidden = false;
    note("Match found. Review before scrobbling.");
  });
  bind("scrobble",async () => { if (match) printReport(await call("submit",{rows:[match]})); });
  refresh().catch(e => note(e.message));
}
