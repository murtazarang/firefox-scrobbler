"use strict";

const API = "https://stream-scrobbler.murtaza2142.workers.dev";
const TWITCH = ["https://www.twitch.tv/*","https://twitch.tv/*"];
const ALARM = "twitch-mirror";
const DAY = 86400;
const seconds = () => Math.floor(Date.now()/1000);
const local = browser.storage.local;
const session = browser.storage.session;
let queue = Promise.resolve();

function serialize(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

async function api(path, data = {}, token) {
  let response;
  try {
    response = await fetch(API + path, {
      method: "POST", body: JSON.stringify(data),
      headers: {"Content-Type":"application/json", ...(token ? {Authorization:"Bearer " + token} : {})},
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(20000)
    });
  } catch { throw Error("Could not reach Stream Scrobbler. Try again later."); }
  let result;
  try { result = await response.json(); } catch { throw Error("Stream Scrobbler did not return an API response."); }
  if (!response.ok) {
    if (response.status === 401 && token) {
      await local.remove(["account","mirrorStatus"]);
      await session.remove("windows");
    }
    const error = Error(result?.error || "Stream Scrobbler HTTP " + response.status + ".");
    error.status = response.status;
    error.code = result?.code;
    throw error;
  }
  return result;
}

// Upgrade in place but never carry an old Last.fm secret or session into the hosted flow.
async function migrate() {
  const {config = {}, account} = await local.get(["config","account"]);
  if (Object.hasOwn(config,"apiKey") || Object.hasOwn(config,"secret")) {
    delete config.apiKey;
    delete config.secret;
    await local.set({config});
    await session.remove("authToken");
  }
  if (account && !account.token) await local.remove(["account","mirrorStatus"]);
}

async function recent(account, profile, {limit, from, to, explainError = false} = {}) {
  if (!account?.token) throw Error("Connect Last.fm in Settings first, or preview pasted plays.");
  const result = [];
  let current = null;
  let pages = 1;
  const perPage = Math.min(200, limit ?? 200);
  for (let page = 1; page <= pages && (limit == null || result.length < limit); page++) {
    if (page > 10) throw Error("Too many Last.fm history pages. Reduce the history limit.");
    let data;
    try {
      data = await api("/recent",{user:profile,limit:perPage,page,
        ...(from != null ? {from} : {}), ...(to != null ? {to} : {})},account.token);
    } catch (error) {
      if (explainError) error.message += (error.code ? " (Last.fm API error " + error.code + ")." : "") + " You can use Paste plays.";
      throw error;
    }
    const feed = data.recenttracks;
    if (!Array.isArray(feed?.track)) throw Error("Last.fm did not return a track list.");
    pages = Number(feed["@attr"]?.totalPages ?? 1);
    if (!Number.isSafeInteger(pages) || pages < 0 || pages > 100000) throw Error("Invalid history page count.");
    for (const row of feed.track) {
      const t = Scrobble.parseTrack(row);
      if (t?.now) current ??= t;
      else if (t && (from == null || t.ts >= from) && (to == null || t.ts <= to)) result.push(t);
    }
  }
  return {current, history: result.slice(0, limit ?? result.length)};
}

async function submit(account, rows, {live = false, source = "", gate} = {}) {
  if (!account?.token) throw Error("Connect your Last.fm account in Settings first.");
  if (source === account.name.toLowerCase()) throw Error("Source and destination are the same Last.fm account.");
  const {ledger = {}} = await local.get("ledger");
  const now = seconds();
  for (const id of Object.keys(ledger)) if (ledger[id] < now - 15*DAY) delete ledger[id];
  const scope = account.name.toLowerCase() + ":";
  const report = {accepted: 0, skipped: 0, rejected: 0, uncertain: 0, codes: []};
  const pending = [];
  for (const row of rows) {
    if (!row.artist || !row.title || !Number.isSafeInteger(row.ts) || row.ts > now || row.ts < now - 14*DAY) {
      report.skipped++;
      continue;
    }
    const id = scope + Scrobble.key(row);
    const alias = row.now ? scope + "now:" + source + ":" + Scrobble.key({...row, ts: null}) : null;
    if (ledger[id] || (alias && ledger[alias] > now - 240) || pending.some(x => x.id === id || (alias && x.alias === alias))) {
      report.skipped++;
      continue;
    }
    pending.push({row,id,alias});
  }
  pending.sort((a,b) => a.row.ts - b.row.ts);
  while (pending.length) {
    if (gate && !await gate()) break;
    const batch = pending.splice(0,50);
    // Reserve before sending: a lost response or browser stop must not cause an automatic double-write.
    for (const {id,alias} of batch) {
      ledger[id] = now;
      if (alias) ledger[alias] = now;
    }
    await local.set({ledger});
    try {
      const {codes} = await api("/scrobble",{rows:batch.map(({row}) => ({
        artist:row.artist,title:row.title,ts:row.ts,...(row.album ? {album:row.album} : {})
      })),live},account.token);
      if (!Array.isArray(codes) || codes.length !== batch.length || codes.some(code => !Number.isSafeInteger(code))) {
        report.uncertain += batch.length;
        break;
      }
      let dailyLimit = false;
      codes.forEach((code,i) => {
        if (code === 0) report.accepted++;
        else {
          report.rejected++;
          if (!report.codes.includes(code)) report.codes.push(code);
          if (code === 5) {
            dailyLimit = true;
            delete ledger[batch[i].id];
            if (batch[i].alias) delete ledger[batch[i].alias];
          }
        }
      });
      await local.set({ledger});
      if (dailyLimit) break;
    } catch (error) {
      report.uncertain += batch.length;
      report.error = error.message;
      break;
    }
  }
  report.skipped += pending.length;
  return report;
}

async function snapshot() {
  const {config = {}, account} = await local.get(["config","account"]);
  const {windows = {}} = await session.get("windows");
  const enabled = (config.mappings || []).filter(m => m.enabled);
  const origins = enabled.length ? (await Promise.all(TWITCH.map(async origin =>
    await browser.permissions.contains({origins:[origin]}) ? origin : null))).filter(Boolean) : [];
  const mappings = account?.token ? enabled.filter(m => m.profile !== account.name.toLowerCase()) : [];
  const tabs = mappings.length && origins.length ? await browser.tabs.query({url:origins}) : [];
  const next = Scrobble.updateWindows(windows, tabs, mappings, seconds());
  await session.set({windows: next});
  const mirrorState = !enabled.length ? "no-mappings"
    : !account?.token ? "disconnected"
    : !mappings.length ? "same-account"
    : !origins.length ? "no-permission"
    : Object.keys(next).length ? "active"
    : origins.length < TWITCH.length ? "partial-permission" : "not-open";
  return {config, account, windows: next, mirrorState};
}

async function mirror(poll) {
  const current = await snapshot();
  const {account, windows} = current;
  if (Object.keys(windows).length) {
    if (!await browser.alarms.get(ALARM)) browser.alarms.create(ALARM, {periodInMinutes: 1});
  } else {
    await browser.alarms.clear(ALARM);
  }
  if (!poll) return current;
  const {mirrorRetryAt = 0} = await session.get("mirrorRetryAt");
  if (seconds() < mirrorRetryAt) return current;
  for (const [profile, w] of Object.entries(windows)) {
    if (profile === account.name.toLowerCase()) continue;
    try {
      const to = seconds();
      const from = Math.max(w.from, to - 14*DAY);
      if (to <= from) continue;
      const rows = (await recent(account, profile, {from: from - 1, to})).history;
      const report = await submit(account, rows.filter(t => t.ts >= from), {
        live: true, source: profile, gate: async () => (await snapshot()).windows[profile]?.since === w.since
      });
      const current = (await snapshot()).windows;
      if (current[profile]?.since !== w.since) continue;
      if (!report.codes.includes(5) && !report.uncertain) {
        current[profile].from = Math.max(w.since, to - 300);
        await session.set({windows: current});
      }
      await local.set({mirrorStatus: {profile, report, time: to}});
    } catch (error) {
      await local.set({mirrorStatus: {profile, report: {error: error.message}, time: seconds()}});
      if (error.status === 503 || error.status === 429 || error.status === 502) {
        await session.set({mirrorRetryAt:seconds() + 180});
        break;
      }
    }
  }
}

function schedule(poll = false) {
  return serialize(async () => { await migrate(); return mirror(poll); }).catch(() => {});
}
browser.alarms.onAlarm.addListener(a => { if (a.name === ALARM) return schedule(true); });
browser.runtime.onStartup.addListener(() => schedule());
browser.runtime.onInstalled.addListener(() => schedule());
browser.tabs.onUpdated.addListener(() => schedule(), {properties:["url", "status"]});
browser.tabs.onRemoved.addListener(() => schedule());
browser.tabs.onCreated.addListener(() => schedule());
browser.permissions.onRemoved.addListener(() => schedule());
browser.permissions.onAdded.addListener(() => schedule());

async function action(message) {
  await migrate();
  if (message.action === "status") {
    const {config,account,windows,mirrorState} = await mirror(false);
    const {mirrorStatus} = await local.get("mirrorStatus");
    return {config: {profiles: config.profiles || [], mappings: config.mappings || [], limit: config.limit || 50,
      hasRecognition: Boolean(config.auddToken)},
      account: account?.name, active: Object.keys(windows), mirrorState, mirrorStatus,
      connecting: Boolean((await session.get("connectionAttempt")).connectionAttempt)};
  }
  const {config = {}, account} = await local.get(["config","account"]);
  if (message.action === "save") {
    const next = {...config};
    for (const key of ["profiles","mappings","limit","auddToken"])
      if (Object.hasOwn(message.config,key)) next[key] = message.config[key];
    await local.set({config: next});
    await mirror(false);
    return true;
  }
  if (message.action === "connect") {
    if (account?.token) throw Error("Disconnect the current Last.fm account before connecting another.");
    const {attempt,url} = await api("/auth/start");
    const target = new URL(url);
    if (typeof attempt !== "string" || !/^[a-f0-9]{64}$/.test(attempt) || target.origin !== "https://www.last.fm" ||
        target.pathname !== "/api/auth/" || target.username || target.password)
      throw Error("Stream Scrobbler returned an invalid Last.fm authorization link.");
    await session.set({connectionAttempt:attempt});
    await browser.tabs.create({url:target.href});
    return true;
  }
  if (message.action === "finish") {
    if (account?.token) throw Error("A Last.fm account is already connected.");
    const {connectionAttempt: attempt} = await session.get("connectionAttempt");
    if (!attempt) throw Error("Click Connect Last.fm first.");
    let linked;
    try { linked = await api("/auth/finish",{attempt}); }
    catch (error) {
      if (error.status === 410) await session.remove("connectionAttempt");
      throw error;
    }
    if (!/^[a-f0-9]{64}$/.test(linked?.token) || typeof linked?.name !== "string" || !linked.name)
      throw Error("Stream Scrobbler did not return a connection.");
    await local.set({account:{token:linked.token,name:linked.name}});
    await session.remove(["connectionAttempt","windows","mirrorRetryAt"]);
    await mirror(false);
    return linked.name;
  }
  if (message.action === "disconnect") {
    if (account?.token) {
      try { await api("/disconnect",{},account.token); }
      catch (error) { if (error.status !== 401) throw error; }
    }
    await local.remove(["account","mirrorStatus"]);
    await session.remove(["connectionAttempt","windows","mirrorRetryAt"]);
    await mirror(false);
    return true;
  }
  if (message.action === "preview") {
    if (!config.profiles?.includes(message.profile)) throw Error("Select a saved Last.fm profile.");
    return recent(account, message.profile, {limit:config.limit || 50, explainError:true});
  }
  if (message.action === "submit") return submit(account, message.rows.map(row =>
    ({...row, ts: row.ts ?? seconds()})), {source:message.source || ""});
  throw Error("Unknown extension action.");
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!sender.url?.startsWith(browser.runtime.getURL("panel.html"))) return false;
  return serialize(() => action(message)).then(data => ({data}), error => ({error: error.message}));
});
