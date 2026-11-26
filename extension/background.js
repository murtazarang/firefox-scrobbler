"use strict";

const API = "https://ws.audioscrobbler.com/2.0/";
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

async function api(config, method, args = {}, opts = {}) {
  if (!config.apiKey) throw Error("Enter a Last.fm API key in Settings.");
  const params = {method, api_key: config.apiKey, ...args};
  if (opts.signed) params.api_sig = Scrobble.signature(params, config.secret);
  params.format = "json";
  const encoded = new URLSearchParams(params);
  let response;
  try {
    response = await fetch(opts.post ? API : API + "?" + encoded, {
      ...(opts.post ? {method: "POST", body: encoded} : {}),
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(20000)
    });
  } catch { throw Error("Could not reach Last.fm."); }
  let result;
  try { result = await response.json(); } catch { throw Error("Last.fm returned an unreadable response."); }
  if (result.error) {
    if (result.error === 9) {
      await local.remove("account");
      throw Error("Your Last.fm session expired. Reconnect in Settings.");
    }
    if (result.error === 14) throw Error("Approve access on Last.fm, then click Finish connecting.");
    if (opts.explainError) {
      let detail = typeof result.message === "string" ? result.message : "";
      for (const sensitive of [config.apiKey, config.secret].filter(Boolean))
        detail = detail.split(sensitive).join("[redacted]");
      detail = detail.replace(/\b[a-f\d]{32,}\b/gi,"[redacted]").replace(/\s+/g," ").trim().slice(0,240);
      throw Error(`Last.fm couldn’t load plays (HTTP ${response.status}, API error ${Number(result.error)}).` +
        (detail ? " " + detail : "") + " You can use Paste plays below.");
    }
    throw Error("Last.fm API error " + Number(result.error) + ".");
  }
  if (!response.ok) throw Error("Last.fm HTTP " + response.status + ".");
  return result;
}

async function recent(config, profile, {limit, from, to, explainError = false} = {}) {
  const result = [];
  let current = null;
  let pages = 1;
  const perPage = Math.min(200, limit ?? 200);
  for (let page = 1; page <= pages && (limit == null || result.length < limit); page++) {
    const data = await api(config, "user.getRecentTracks", {
      user: profile, limit: perPage, page, ...(from ? {from} : {}), ...(to ? {to} : {})
    }, {explainError});
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

async function submit(config, account, rows, {live = false, source = "", gate} = {}) {
  if (!account?.key) throw Error("Connect your Last.fm account in Settings first.");
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
    const args = {sk: account.key};
    batch.forEach(({row}, i) => {
      args["artist["+i+"]"] = row.artist;
      args["track["+i+"]"] = row.title;
      args["timestamp["+i+"]"] = row.ts;
      if (row.album) args["album["+i+"]"] = row.album;
      if (live) args["chosenByUser["+i+"]"] = 0;
    });
    // Reserve before sending: a lost response or browser stop must not cause an automatic double-write.
    for (const {id,alias} of batch) {
      ledger[id] = now;
      if (alias) ledger[alias] = now;
    }
    await local.set({ledger});
    try {
      const x = (await api(config, "track.scrobble", args, {signed: true, post: true})).scrobbles?.scrobble;
      const results = Array.isArray(x) ? x : (x ? [x] : []);
      if (results.length !== batch.length || results.some(r => !/^\d+$/.test(String(r.ignoredMessage?.code)))) {
        report.uncertain += batch.length;
        break;
      }
      let dailyLimit = false;
      results.forEach((r,i) => {
        const code = Number(r.ignoredMessage.code);
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
  const mappings = account?.key ? enabled.filter(m => m.profile !== account.name.toLowerCase()) : [];
  const tabs = mappings.length && origins.length ? await browser.tabs.query({url:origins}) : [];
  const next = Scrobble.updateWindows(windows, tabs, mappings, seconds());
  await session.set({windows: next});
  const mirrorState = !enabled.length ? "no-mappings"
    : !account?.key ? "disconnected"
    : !mappings.length ? "same-account"
    : !origins.length ? "no-permission"
    : Object.keys(next).length ? "active"
    : origins.length < TWITCH.length ? "partial-permission" : "not-open";
  return {config, account, windows: next, mirrorState};
}

async function mirror(poll) {
  const current = await snapshot();
  const {config, account, windows} = current;
  if (Object.keys(windows).length) {
    if (!await browser.alarms.get(ALARM)) browser.alarms.create(ALARM, {periodInMinutes: 1});
  } else {
    await browser.alarms.clear(ALARM);
  }
  if (!poll) return current;
  for (const [profile, w] of Object.entries(windows)) {
    if (profile === account.name.toLowerCase()) continue;
    try {
      const to = seconds();
      const from = Math.max(w.from, to - 14*DAY);
      if (to <= from) continue;
      const rows = (await recent(config, profile, {from: from - 1, to})).history;
      const report = await submit(config, account, rows.filter(t => t.ts >= from), {
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
    }
  }
}

function schedule(poll = false) {
  return serialize(() => mirror(poll)).catch(() => {});
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
  if (message.action === "status") {
    const {config,account,windows,mirrorState} = await mirror(false);
    const {mirrorStatus} = await local.get("mirrorStatus");
    return {config: {profiles: config.profiles || [], mappings: config.mappings || [], limit: config.limit || 50,
      hasKey: Boolean(config.apiKey), hasRecognition: Boolean(config.auddToken)},
      account: account?.name, active: Object.keys(windows), mirrorState, mirrorStatus,
      connecting: Boolean((await session.get("authToken")).authToken)};
  }
  const {config = {}, account} = await local.get(["config","account"]);
  if (message.action === "save") {
    const next = {...config, ...message.config};
    if (next.apiKey !== config.apiKey || next.secret !== config.secret) {
      await local.remove("account");
      await session.remove("authToken");
    }
    await local.set({config: next});
    await mirror(false);
    return true;
  }
  if (message.action === "connect") {
    const {apiKey,secret} = message;
    if (Boolean(apiKey) !== Boolean(secret)) throw Error("Paste both Last.fm credentials.");
    const next = apiKey ? {...config,apiKey,secret} : config;
    if (!next.apiKey || !next.secret) throw Error("Enter your Last.fm API key and shared secret in Settings first.");
    const {token} = await api(next, "auth.getToken", {}, {signed: true});
    if (!token) throw Error("Last.fm didn’t return an authorization token.");
    if (next.apiKey !== config.apiKey || next.secret !== config.secret) {
      await local.remove("account");
      await local.set({config:next});
      await mirror(false);
    }
    await session.set({authToken: token});
    await browser.tabs.create({url:"https://www.last.fm/api/auth/?" + new URLSearchParams({api_key:next.apiKey,token})});
    return true;
  }
  if (message.action === "finish") {
    const {authToken: token} = await session.get("authToken");
    if (!token) throw Error("Click Connect Last.fm first.");
    const {session: linked} = await api(config, "auth.getSession", {token}, {signed: true});
    if (!linked?.key || !linked.name) throw Error("Last.fm did not return a session.");
    await local.set({account:{key:linked.key,name:linked.name}});
    await session.remove("authToken");
    await mirror(false);
    return linked.name;
  }
  if (message.action === "disconnect") {
    await local.remove(["account","mirrorStatus"]);
    await session.remove("authToken");
    await mirror(false);
    return true;
  }
  if (message.action === "preview") {
    if (!config.profiles?.includes(message.profile)) throw Error("Select a saved Last.fm profile.");
    return recent(config, message.profile, {limit:config.limit || 50, explainError:true});
  }
  if (message.action === "submit") return submit(config, account, message.rows.map(row =>
    ({...row, ts: row.ts ?? seconds()})), {source:message.source || ""});
  throw Error("Unknown extension action.");
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!sender.url?.startsWith(browser.runtime.getURL("panel.html"))) return false;
  return serialize(() => action(message)).then(data => ({data}), error => ({error: error.message}));
});
