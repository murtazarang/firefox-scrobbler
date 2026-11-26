const API = "https://ws.audioscrobbler.com/2.0/";
const utf = new TextEncoder();
const decoder = new TextDecoder();
const now = () => Math.floor(Date.now() / 1000);
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async (algorithm, value) => hex(await crypto.subtle.digest(algorithm, utf.encode(value)));
const hash = value => digest("SHA-256", value);
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const un64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const LIMIT = 64 * 1024;

class Fault extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function reply(data, status = 200, headers = {}) {
  return Response.json(data, {status, headers: {"Cache-Control":"no-store", ...headers}});
}

async function body(request) {
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json"))
    throw new Fault(415, "Expected JSON.");
  if (Number(request.headers.get("Content-Length")) > LIMIT) throw new Fault(413, "Request too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new Fault(400, "Expected a request body.");
  const parts = [];
  const decoder = new TextDecoder();
  let length = 0;
  for (;;) {
    const {value,done} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > LIMIT) {
      await reader.cancel();
      throw new Fault(413, "Request too large.");
    }
    parts.push(decoder.decode(value, {stream:true}));
  }
  parts.push(decoder.decode());
  try {
    const value = JSON.parse(parts.join(""));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new Fault(400, "Invalid JSON.");
}

async function limited(binding, key) {
  if (!(await binding.limit({key})).success) throw new Fault(429, "Too many requests. Wait a minute and try again.");
}

async function lastfm(env, method, fields = {}, signed = false, post = false) {
  const p = {method,api_key:env.LASTFM_API_KEY,...fields};
  if (signed) {
    const canonical = Object.keys(p).sort().map(k => k + p[k]).join("");
    // MD5 is required by Last.fm's API protocol; never used for local credentials.
    p.api_sig = await digest("MD5", canonical + env.LASTFM_SHARED_SECRET);
  }
  p.format = "json";
  const data = new URLSearchParams(p);
  let response, result;
  try {
    response = await fetch(post ? API : API + "?" + data, {
      ...(post ? {method:"POST", body:data} : {}),
      redirect:"manual", signal:AbortSignal.timeout(15000)
    });
    if (response.status >= 300 && response.status < 400) throw new Error("Unexpected upstream redirect");
    result = await response.json();
  } catch {
    throw new Fault(502, "Could not get a usable response from Last.fm.");
  }
  const code = Number(result?.error);
  if (code === 14) throw new Fault(409, "Approve access on Last.fm, then click Finish connecting.", code);
  if (code === 9) throw new Fault(401, "Your Last.fm session is no longer valid. Connect again.", code);
  if ([8,11,16,29].includes(code) || response.status >= 500 || response.status === 429)
    throw new Fault(503, "Last.fm is temporarily unavailable. Try again later.", code || undefined);
  if (code || !response.ok)
    throw new Fault(502, "Last.fm rejected the request.", code || undefined);
  return result;
}

async function encryptionKey(env) {
  const bytes = un64(env.SESSION_ENCRYPTION_KEY);
  if (bytes.length !== 32) throw new Error("Invalid session encryption key");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt","decrypt"]);
}

async function seal(env, value, id) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {name:"AES-GCM",iv,additionalData:utf.encode(id)}, await encryptionKey(env), utf.encode(value));
  return b64(iv) + "." + b64(ciphertext);
}

async function unseal(env, value, id) {
  const [iv, ciphertext] = value.split(".");
  return decoder.decode(await crypto.subtle.decrypt(
    {name:"AES-GCM",iv:un64(iv),additionalData:utf.encode(id)}, await encryptionKey(env), un64(ciphertext)));
}

const text = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && v.trim() !== "" && !/\u0000/.test(v);
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

async function authenticated(request, env) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization") || "");
  if (!match) throw new Fault(401, "Connect Last.fm in Settings first.");
  const id = await hash(match[1]);
  const record = await env.DB.prepare("SELECT username, sealed_key FROM sessions WHERE token_hash = ?").bind(id).first();
  if (!record) throw new Fault(401, "Connection not found. Connect Last.fm again.");
  return {id, ...record};
}

async function start(env) {
  await encryptionKey(env); // Fail before contacting Last.fm if setup is incomplete.
  await env.DB.prepare("DELETE FROM connections WHERE expires_at <= ?").bind(now()).run();
  const result = await lastfm(env,"auth.getToken",{},true);
  if (!text(result?.token,256)) throw new Fault(502,"Last.fm did not return a connection token.");
  const attempt = token(), id = await hash(attempt);
  await env.DB.prepare("INSERT INTO connections VALUES (?, ?, ?)").bind(
    id,await seal(env,result.token,id),now()+600).run();
  const url = new URL("https://www.last.fm/api/auth/");
  url.search = new URLSearchParams({api_key:env.LASTFM_API_KEY,token:result.token});
  return {attempt, url:url.href};
}

async function finish(request, env) {
  const {attempt} = await body(request);
  if (typeof attempt !== "string" || !/^[a-f0-9]{64}$/.test(attempt))
    throw new Fault(400,"Start a new Last.fm connection.");
  const id = await hash(attempt);
  const row = await env.DB.prepare("SELECT lastfm_token FROM connections WHERE token_hash = ? AND expires_at > ?")
    .bind(id,now()).first();
  if (!row) throw new Fault(410,"Connection attempt expired or was used. Click Connect Last.fm again.");
  const {session} = await lastfm(env,"auth.getSession",{token:await unseal(env,row.lastfm_token,id)},true);
  if (!text(session?.key,256) || !text(session?.name,128))
    throw new Fault(502,"Last.fm did not return a valid session.");
  const credential = token(), keyHash = await hash(credential);
  const sealed = await seal(env,session.key,keyHash);
  // Claim and create in one D1 transaction; only a still-live attempt can mint a session.
  const [insert] = await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions SELECT ?, ?, ? FROM connections WHERE token_hash = ? AND expires_at > ?")
      .bind(keyHash,session.name,sealed,id,now()),
    env.DB.prepare("DELETE FROM connections WHERE token_hash = ?").bind(id)
  ]);
  if (insert.meta.changes !== 1) throw new Fault(410,"Connection attempt expired or was used.");
  return {name:session.name, token:credential};
}

async function recent(request,env) {
  const {user,limit,page,from,to} = await body(request);
  if (typeof user !== "string" || !/^[a-z0-9_-]{1,64}$/i.test(user) || !integer(limit,1,200) ||
      !integer(page,1,10) || (from !== undefined && !integer(from,0,now())) ||
      (to !== undefined && !integer(to,0,now())) || (from !== undefined && to !== undefined && from > to))
    throw new Fault(400,"Invalid recent-tracks request.");
  const result = await lastfm(env,"user.getRecentTracks",{user,limit,page,
    ...(from !== undefined ? {from} : {}), ...(to !== undefined ? {to} : {})});
  const feed = result?.recenttracks;
  if (!Array.isArray(feed?.track)) throw new Fault(502,"Last.fm did not return a track list.");
  return {recenttracks:{track:feed.track.slice(0,201).map(row => ({
    name:row?.name, artist:{"#text":row?.artist?.["#text"] || row?.artist?.name}, album:{"#text":row?.album?.["#text"]},
    date:{uts:row?.date?.uts}, "@attr":{nowplaying:row?.["@attr"]?.nowplaying}
  })), "@attr":{totalPages:feed["@attr"]?.totalPages}}};
}

async function scrobble(request,env,account) {
  const {rows,live} = await body(request);
  const time = now();
  if (typeof live !== "boolean" || !Array.isArray(rows) || rows.length < 1 || rows.length > 50 ||
    rows.some(r => !r || !text(r.artist,512) || !text(r.title,512) ||
     (r.album && !text(r.album,512)) || !integer(r.ts,time-14*86400,time+60)))
    throw new Fault(400,"Invalid scrobble batch.");
  const args = {sk:await unseal(env,account.sealed_key,account.id)};
  rows.forEach((r,i) => {
    args["artist["+i+"]"] = r.artist;
    args["track["+i+"]"] = r.title;
    args["timestamp["+i+"]"] = r.ts;
    if (r.album) args["album["+i+"]"] = r.album;
    if (live) args["chosenByUser["+i+"]"] = 0;
  });
  let data;
  try { data = (await lastfm(env,"track.scrobble",args,true,true))?.scrobbles?.scrobble; }
  catch (error) {
    if (error.code === 9)
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(account.id).run();
    throw error;
  }
  const list = Array.isArray(data) ? data : data ? [data] : [];
  if (list.length !== rows.length || list.some(r => !/^\d+$/.test(String(r?.ignoredMessage?.code))))
    throw new Fault(502,"Last.fm did not confirm the batch. Check your history before retrying.");
  return {codes:list.map(r => Number(r.ignoredMessage.code))};
}

export default {
  async fetch(request,env) {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/health") return reply({ok:true});
      if (request.method !== "POST" ||
          !["/auth/start","/auth/finish","/disconnect","/recent","/scrobble"].includes(path))
        return reply({error:"Not found."},404);
      if (path.startsWith("/auth/")) {
        await limited(env.AUTH_LIMIT,request.headers.get("CF-Connecting-IP") || "unknown");
        return reply(path === "/auth/start" ? await start(env) : await finish(request,env));
      }
      const account = await authenticated(request,env);
      if (path === "/disconnect") {
        await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(account.id).run();
        return reply({ok:true});
      }
      await limited(env.USER_LIMIT,account.username.toLowerCase());
      if (path === "/recent") return reply(await recent(request,env));
      return reply(await scrobble(request,env,account));
    } catch (error) {
      if (!(error instanceof Fault)) return reply({error:"The Stream Scrobbler service could not complete the request."},500);
      return reply({error:error.message,code:error.code},error.status,error.status === 429 ? {"Retry-After":"60"} : {});
    }
  }
};
