const test = require("node:test");
const assert = require("node:assert/strict");
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
function harness({feed, result, config = {}, disconnected = false, legacy = false} = {}) {
  let now = tick, tabs = [], enabled = true;
  const requests = [], newTabs = [], alarms = new Map();
  const local = storage({config:{...(legacy && {apiKey:"old-key",secret:"old-secret"}),profiles:["bob"],limit:10,
    mappings:[{channel:"alice",profile:"bob",enabled:true}],...config},
    ...(!disconnected && {account:legacy ? {key:"old-session",name:"me"} : {token:"c".repeat(64),name:"me"}})});
  const session = storage();
  const browser = {
    storage:{local,session}, alarms:{onAlarm:event(),get:k=>alarms.get(k),create:(k,v)=>alarms.set(k,v),clear:k=>alarms.delete(k)},
    runtime:{onStartup:event(),onInstalled:event(),onMessage:event(),getURL:p=>"moz-extension://test/"+p},
    permissions:{contains:({origins})=>Array.isArray(enabled) ? origins.every(o=>enabled.includes(o)) : enabled,onRemoved:event(),onAdded:event()},
    tabs:{onUpdated:event(),onRemoved:event(),onCreated:event(),query:({url}={})=>url ? tabs.filter(t=>url.some(o=>t.url.startsWith(o.slice(0,-1)))) : tabs,create:x=>newTabs.push(x)}
  };
  const fetch = async (url, opts) => {
    assert.equal(opts.credentials,"omit");
    assert.equal(new URL(url).origin,"https://stream-scrobbler.murtaza2142.workers.dev");
    const params = JSON.parse(opts.body);
    const route = new URL(url).pathname;
    requests.push({params, opts, route});
    const data = route === "/recent" ? (feed?.(params) ?? {recenttracks:{track:[]}}) :
      route === "/auth/start" ? {attempt:"a".repeat(64),url:"https://www.last.fm/api/auth/?api_key=public&token=once"} :
      route === "/auth/finish" ? {token:"c".repeat(64),name:"me"} :
      route === "/disconnect" ? {ok:true} :
      result ? result(params) : {codes:params.rows.map(()=>0)};
    return {ok:!data.error,status:data.error ? 503 : 200,json:async()=>data};

  };
  const context = vm.createContext({browser,fetch,URL,URLSearchParams,AbortSignal,TextEncoder,Date:{now:()=>now*1000}});
  for (const path of model.background.scripts) vm.runInContext(readFileSync("extension/"+path,"utf8"),context);
  return {requests,newTabs,local,session,browser,alarms,
    clock:n=>{now=n}, tabs:x=>{tabs=x}, permission:x=>{enabled=x},
    send:(action,args)=>browser.runtime.onMessage.fire({action,...args},{url:browser.runtime.getURL("panel.html")}),
    poll:()=>browser.alarms.onAlarm.fire({name:"twitch-mirror"})};
}

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
  assert.equal(h.local.values.account.token,"c".repeat(64));
  await h.send("disconnect");
  assert.equal(h.local.values.account,undefined);
  assert.deepEqual(h.requests.map(x=>x.route),["/auth/start","/auth/finish","/disconnect"]);
  assert.equal(h.requests[1].params.attempt,"a".repeat(64));
  assert.equal(h.requests[2].opts.headers.Authorization,"Bearer "+"c".repeat(64));
});
test("preview separates Now Playing, pages through history, and never writes",async()=>{
  const h = harness({config:{limit:2},feed:p=>({recenttracks:{"@attr":{totalPages:"2"},track:p.page===1 ?
    [{name:"Current",artist:{"#text":"Artist"},"@attr":{nowplaying:"true"}},row("First",tick-60)] : [row("Second",tick-120)]}})});
  const preview = (await h.send("preview",{profile:"bob"})).data;
  assert.equal(preview.current.title,"Current");
  assert.equal(preview.current.ts,null);
  assert.deepEqual(Array.from(preview.history,x=>x.title),["First","Second"]);
  assert.ok(h.requests.every(x=>x.route==="/recent"));
});
test("manual submits in batches of 50, preserves time, skips old and repeat plays",async()=>{
  const h = harness();
  const rows = Array.from({length:51},(_,i)=>track("Track",tick-100-i));
  rows.push(track("Too old",tick-15*86400));
  const a = (await h.send("submit",{rows,source:"bob"})).data;
  assert.equal(a.accepted,51); assert.equal(a.skipped,1);
  assert.deepEqual(h.requests.map(x=>x.opts.method),["POST","POST"]);
  assert.equal(h.requests[0].params.rows[0].ts,tick-150);
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
  assert.deepEqual(h.requests.filter(x=>x.route==="/scrobble").map(x=>x.params.rows[0].title),["First"]);
  assert.equal(h.requests.find(x=>x.route==="/scrobble").params.live,true);
  h.tabs([]);
  await h.browser.tabs.onRemoved.fire();
  assert.equal(h.alarms.size,0);
  h.clock(tick+90);
  h.tabs([{url:host+"alice"}]);
  await h.browser.tabs.onUpdated.fire();
  h.clock(tick+120);
  await h.poll();
  assert.equal(h.requests.filter(x=>x.route==="/scrobble").length,1);
});
test("reports per-track filtering even when the API request succeeded",async()=>{
  const h = harness({result:()=>({codes:[2]})});
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

test("upgrade drops BYO Last.fm secrets and session without losing preferences",async()=>{
  const h = harness({legacy:true,config:{auddToken:"keep"}});
  const state = (await h.send("status")).data;
  assert.equal(state.account,undefined);
  assert.equal(h.local.values.account,undefined);
  assert.equal(h.local.values.config.apiKey,undefined);
  assert.equal(h.local.values.config.secret,undefined);
  assert.equal(h.local.values.config.auddToken,"keep");
  assert.deepEqual(h.local.values.config.profiles,["bob"]);
  assert.ok((await h.send("connect")).data);
  assert.deepEqual(h.requests[0].params,{});
  assert.equal(new URL(h.newTabs[0].url).searchParams.get("api_key"),"public");
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

test("manual preview surfaces the Last.fm outage and paste fallback",async()=>{
  const h = harness({feed:()=>({error:"Last.fm is temporarily unavailable.",code:8})});
  const reply = await h.send("preview",{profile:"bob"});
  assert.match(reply.error,/Last.fm API error 8/);
  assert.match(reply.error,/Paste plays/);
  assert.equal(h.requests[0].route,"/recent");
  assert.equal(h.requests.length,1);
});

test("Twitch polling backs off for three minutes after an upstream error",async()=>{
  const h = harness({feed:()=>({error:"Last.fm is temporarily unavailable.",code:8})});
  h.tabs([{url:host+"alice"}]);
  await h.browser.tabs.onUpdated.fire();
  h.clock(tick+60);
  await h.poll();
  h.clock(tick+120);
  await h.poll();
  assert.equal(h.requests.length,1);
  h.clock(tick+240);
  await h.poll();
  assert.equal(h.requests.length,2);
});

test("copies an English Recent Tracks table verbatim, including repeated plays",()=>{
  const header = "Play \tAlbum \tLoved \tTrack name \tArtist name \tBuy \tOptions \tTimestamp";
  const tableRow = (play,album,loved,title,artist,time) =>
    [play,album,loved,title,artist,"Buy","More",time].join("\n\t\n");
  const aphex = tableRow("","Selected Ambient Works Volume II","VJRadio doesn't love this track","Untitled","Aphex Twin","4 hours ago");
  const raw = [header,aphex,aphex,tableRow("Play track","Walking on","VJRadio loves this track","Alma Ata","The Ananda Shankar Experience","5 hours ago")].join("\n\t\n");
  const plays = core.parsePastedPlays(raw,tick);
  assert.equal(plays.length,3);
  assert.deepEqual(plays[0],{artist:"Aphex Twin",title:"Untitled",album:"Selected Ambient Works Volume II",ts:tick-14400,approximate:true});
  assert.deepEqual(plays[1],plays[0]);
  assert.equal(plays[2].artist,"The Ananda Shankar Experience");
  assert.equal(plays[2].ts,tick-18000);
  assert.throws(()=>core.parsePastedPlays(raw.replace("5 hours ago","some time"),tick),/Play 3/);
});

test("pasted exact times accept seconds or a timezone and reject invented dates",()=>{
  const raw = "Artist | Track | 2026-11-25T14:00:00-05:00\nSecond\tTrack\t1795614000";
  const plays = core.parsePastedPlays(raw);
  assert.equal(plays[0].ts, Date.parse("2026-11-25T19:00:00Z")/1000);
  assert.equal(plays[1].ts,1795614000);
  assert.throws(()=>core.parsePastedPlays("A | T | 2026-11-25T14:00:00"),/Line 1/);
  assert.throws(()=>core.parsePastedPlays("A | T | 2026-02-30T14:00:00Z"),/Line 1/);
});
