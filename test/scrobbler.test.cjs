const test = require("node:test");
const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const {readFileSync} = require("node:fs");
const vm = require("node:vm");
const core = require("../extension/core.js");
const model = JSON.parse(readFileSync("extension/manifest.json"));
const host = "https://www.twitch.tv/";
const row = (name, ts) => ({name, artist:{"#text":"Artist"}, date:{uts:String(ts)}});
const track = (title, ts) => ({title, artist:"Artist", ts});
const tick = 1795651200;
const event = () => ({addListener(fn){ this.fire = fn; }});
function storage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      return Object.fromEntries([keys].flat().filter(k => k in values).map(k => [k,structuredClone(values[k])]));
    },
    async set(data){ Object.assign(values,structuredClone(data)); },
    async remove(keys){ [keys].flat().forEach(k => delete values[k]); }
  };
}
function harness({feed, result, config = {}, disconnected = false} = {}) {
  let now = tick, tabs = [], enabled = true;
  const requests = [], newTabs = [], alarms = new Map();
  const local = storage({config:{apiKey:"test",secret:"example",profiles:["bob"],limit:10,
    mappings:[{channel:"alice",profile:"bob",enabled:true}],...config},
    ...(!disconnected && {account:{key:"session",name:"me"}})});
  const session = storage();
  const browser = {
    storage:{local,session}, alarms:{onAlarm:event(),get:k=>alarms.get(k),create:(k,v)=>alarms.set(k,v),clear:k=>alarms.delete(k)},
    runtime:{onStartup:event(),onInstalled:event(),onMessage:event(),getURL:p=>"moz-extension://test/"+p},
    permissions:{contains:({origins})=>Array.isArray(enabled) ? origins.every(o=>enabled.includes(o)) : enabled,onRemoved:event(),onAdded:event()},
    tabs:{onUpdated:event(),onRemoved:event(),onCreated:event(),query:({url}={})=>url ? tabs.filter(t=>url.some(o=>t.url.startsWith(o.slice(0,-1)))) : tabs,create:x=>newTabs.push(x)}
  };
  const fetch = async (url, opts) => {
    assert.equal(opts.credentials,"omit");
    assert.equal(new URL(url).origin,"https://ws.audioscrobbler.com");
    const params = Object.fromEntries(opts.body || new URL(url).searchParams);
    requests.push({params, opts});
    const method = params.method;
    const data = method === "user.getRecentTracks" ? (feed?.(params) ?? {recenttracks:{track:[]}}) :
      method === "auth.getToken" ? {token:"once"} :
      method === "auth.getSession" ? {session:{key:"session",name:"me"}} :
      result ? result(params) : {scrobbles:{scrobble:Object.keys(params).filter(k=>k.startsWith("artist[")).map(()=>({ignoredMessage:{code:"0"}}))}};
    return {ok:true,json:async()=>data};
  };
  const context = vm.createContext({browser,fetch,URL,URLSearchParams,AbortSignal,TextEncoder,Date:{now:()=>now*1000}});
  for (const path of model.background.scripts) vm.runInContext(readFileSync("extension/"+path,"utf8"),context);
  return {requests,newTabs,local,session,browser,alarms,
    clock:n=>{now=n}, tabs:x=>{tabs=x}, permission:x=>{enabled=x},
    send:(action,args)=>browser.runtime.onMessage.fire({action,...args},{url:browser.runtime.getURL("panel.html")}),
    poll:()=>browser.alarms.onAlarm.fire({name:"twitch-mirror"})};
}

test("MD5 agrees with Node over UTF-8 and block boundaries",()=>{
  for (const s of ["","abc","é🎵",...Array.from({length:81},(_,i)=>"x".repeat(i+48))])
    assert.equal(core.md5(s),createHash("md5").update(s).digest("hex"));
});
test("Last.fm signature sorts indexed fields in ASCII order",()=>{
  const args = {"artist[1]":"A","artist[10]":"B",api_key:"key",format:"json",method:"track.scrobble"};
  assert.equal(core.signature(args,"secret"),createHash("md5").update("api_keykeyartist[10]Bartist[1]Amethodtrack.scrobblesecret").digest("hex"));
});
test("exact profile and channel paths, no spoofed origins or VODs",()=>{
  assert.equal(core.nameFromUrl(host+"User_1?foo=bar","twitch"),"user_1");
  for (const url of ["https://twitch.tv.evil/user","https://twitch.tv/alice/clips","https://twitch.tv/videos/123","https://alice@twitch.tv/test"])
    assert.equal(core.nameFromUrl(url,"twitch"),null);
  assert.equal(core.nameFromUrl("https://www.last.fm/user/Alice_1","lastfm"),"alice_1");
});
test("Last.fm approval creates a separate API session; no cookies",async()=>{
  const h = harness({disconnected:true});
  assert.ok((await h.send("connect")).data);
  assert.equal(new URL(h.newTabs[0].url).searchParams.get("token"),"once");
  assert.equal((await h.send("finish")).data,"me");
  assert.equal(h.local.values.account.key,"session");
  await h.send("disconnect");
  assert.equal(h.local.values.account,undefined);
  assert.equal(h.requests.length,2);
  assert.ok(h.requests.every(x=>x.params.api_sig && !x.opts.body));
});
test("preview separates Now Playing, pages through history, and never writes",async()=>{
  const h = harness({config:{limit:2},feed:p=>({recenttracks:{"@attr":{totalPages:"2"},track:p.page==="1" ?
    [{name:"Current",artist:{"#text":"Artist"},"@attr":{nowplaying:"true"}},row("First",tick-60)] : [row("Second",tick-120)]}})});
  const preview = (await h.send("preview",{profile:"bob"})).data;
  assert.equal(preview.current.title,"Current");
  assert.equal(preview.current.ts,null);
  assert.deepEqual(Array.from(preview.history,x=>x.title),["First","Second"]);
  assert.ok(h.requests.every(x=>x.params.method==="user.getRecentTracks"));
});
test("manual submits in batches of 50, preserves time, skips old and repeat plays",async()=>{
  const h = harness();
  const rows = Array.from({length:51},(_,i)=>track("Track",tick-100-i));
  rows.push(track("Too old",tick-15*86400));
  const a = (await h.send("submit",{rows,source:"bob"})).data;
  assert.equal(a.accepted,51); assert.equal(a.skipped,1);
  assert.deepEqual(h.requests.map(x=>x.opts.method),["POST","POST"]);
  assert.equal(h.requests[0].params["timestamp[0]"],String(tick-150));
  assert.equal((await h.send("submit",{rows,source:"bob"})).data.skipped,52);
  assert.equal(h.requests.length,2);
});
test("muted, idle background Twitch tabs mirror exactly once and never backfill between openings",async()=>{
  const h = harness({feed:()=>({recenttracks:{track:[row("Old",tick-80),row("First",tick+30),row("Closed",tick+75)]}})});
  await h.browser.runtime.onStartup.fire();
  assert.equal(h.alarms.size,0);
  h.tabs([{url:host+"alice",active:false,audible:false,mutedInfo:{muted:true},discarded:true},{url:host+"alice",active:false}]);
  await h.browser.tabs.onUpdated.fire();
  assert.equal(h.alarms.size,1);
  h.clock(tick+60);
  await h.poll();
  await h.poll();
  assert.deepEqual(h.requests.filter(x=>x.opts.body).map(x=>x.params["track[0]"]),["First"]);
  assert.equal(h.requests.find(x=>x.opts.body).params["chosenByUser[0]"],"0");
  h.tabs([]);
  await h.browser.tabs.onRemoved.fire();
  assert.equal(h.alarms.size,0);
  h.clock(tick+90);
  h.tabs([{url:host+"alice"}]);
  await h.browser.tabs.onUpdated.fire();
  h.clock(tick+120);
  await h.poll();
  assert.equal(h.requests.filter(x=>x.opts.body).length,1);
});
test("reports per-track filtering even when the API request succeeded",async()=>{
  const h = harness({result:()=>({scrobbles:{scrobble:{ignoredMessage:{code:"2"}}}})});
  const a = (await h.send("submit",{rows:[track("Filtered",tick-30)]})).data;
  assert.equal(a.rejected,1);
  assert.equal(a.accepted,0);
});
test("ambiguous submission is not repeated automatically",async()=>{
  const h = harness({result:()=>({})});
  const rows = [track("One",tick-30)];
  assert.equal((await h.send("submit",{rows})).data.uncertain,1);
  assert.equal((await h.send("submit",{rows})).data.skipped,1);
  assert.equal(h.requests.length,1);
});

test("Connect Last.fm saves new credentials, signs the token request, and opens approval",async()=>{
  const h = harness({config:{apiKey:"",secret:""},disconnected:true});
  assert.ok((await h.send("connect",{apiKey:"only-one"})).error);
  assert.equal(h.requests.length,0);
  assert.ok((await h.send("connect",{apiKey:"new-key",secret:"new-secret"})).data);
  assert.equal(h.local.values.config.apiKey,"new-key");
  assert.equal(h.local.values.config.secret,"new-secret");
  assert.equal(h.requests[0].params.api_sig,core.signature({method:"auth.getToken",api_key:"new-key"},"new-secret"));
  assert.equal(new URL(h.newTabs[0].url).searchParams.get("api_key"),"new-key");
  assert.equal((await h.send("finish")).data,"me");
});

test("opening the popup refreshes mapped Twitch tabs without writing and accepts a single granted host",async()=>{
  const h = harness();
  h.permission(["https://www.twitch.tv/*"]);
  h.tabs([{url:host+"alice", active:false, mutedInfo:{muted:true}, discarded:true}]);
  const status = (await h.send("status")).data;
  assert.equal(status.mirrorState,"active");
  assert.deepEqual(Array.from(status.active),["bob"]);
  assert.equal(h.alarms.size,1);
  assert.equal(h.requests.length,0);
  h.tabs([{url:"https://twitch.tv/alice"}]);
  assert.equal((await h.send("status")).data.mirrorState,"partial-permission");
  h.permission(false);
  assert.equal((await h.send("status")).data.mirrorState,"no-permission");
  assert.equal(h.alarms.size,0);
  assert.equal((await harness({disconnected:true}).send("status")).data.mirrorState,"disconnected");
});
