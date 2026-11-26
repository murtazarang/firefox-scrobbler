const test = require("node:test");
const assert = require("node:assert/strict");
const {createHash, randomBytes} = require("node:crypto");
const {DatabaseSync} = require("node:sqlite");
const {readFileSync} = require("node:fs");
const {mock} = require("node:test");

test("hosted auth, account isolation, Last.fm request signing and error handling", async t => {
  const {default: worker} = await import("../worker/index.mjs");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("worker/migrations/0001_sessions.sql","utf8"));
  t.after(()=>db.close());
  const bind = (sql,args) => ({
    first:async()=>db.prepare(sql).get(...args),
    run:()=>({meta:db.prepare(sql).run(...args)})
  });
  const env = {
    DB:{prepare:sql=>({bind:(...args)=>bind(sql,args)}),batch:async statements=>{
      db.exec("BEGIN");
      try { const results = statements.map(s=>s.run()); db.exec("COMMIT"); return results; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    }},
    AUTH_LIMIT:{limit:async()=>({success:!rateLimited})},
    USER_LIMIT:{limit:async()=>({success:!rateLimited})},
    LASTFM_API_KEY:"app-key",LASTFM_SHARED_SECRET:"backend-only",
    SESSION_ENCRYPTION_KEY:randomBytes(32).toString("base64")
  };
  let rateLimited = false, outage = false, invalidSession = false, serial = 0;
  const approved = new Map(), calls = [];
  // Node's Web Crypto does not implement MD5. Cloudflare does; emulate only that
  // digest here and leave SHA-256 and AES-GCM on the real Web Crypto primitives.
  const realDigest = crypto.subtle.digest.bind(crypto.subtle);
  mock.method(crypto.subtle,"digest",async (algorithm,data) =>
    algorithm === "MD5" ? Uint8Array.from(createHash("md5").update(data).digest()).buffer : realDigest(algorithm,data));
  mock.method(globalThis,"fetch",async (url,init) => {
    assert.equal(init.redirect,"manual");
    assert.equal(new URL(url).origin,"https://ws.audioscrobbler.com");
    const p = Object.fromEntries(init?.body || new URL(url).searchParams);
    assert.equal(p.api_key,"app-key");
    calls.push(p);
    if (p.method !== "user.getRecentTracks") {
      const s = Object.keys(p).filter(k=>k!=="api_sig" && k!=="format").sort().map(k=>k+p[k]).join("");
      assert.equal(p.api_sig,createHash("md5").update(s+"backend-only").digest("hex"));
    }
    if (p.method === "auth.getToken") return Response.json({token:"lastfm-"+(++serial)});
    if (p.method === "auth.getSession") {
      if (!approved.has(p.token)) return Response.json({error:14});
      const name = approved.get(p.token);
      approved.delete(p.token);
      return Response.json({session:{name,key:"private-"+name}});
    }
    if (p.method === "user.getRecentTracks") {
      if (outage) return Response.json({error:8,message:"never echo "+env.LASTFM_SHARED_SECRET},{status:500});
      assert.equal(p.user,"VJRadio");
      return Response.json({recenttracks:{track:[{name:"Example",artist:{"#text":"Artist"}}],"@attr":{totalPages:1}}});
    }
    assert.equal(p.method,"track.scrobble");
    assert.equal(init.method,"POST");
    if (invalidSession) return Response.json({error:9});
    return Response.json({scrobbles:{scrobble:Object.keys(p).filter(k=>k.startsWith("artist["))
      .map((_,i)=>({ignoredMessage:{code:i===1 ? "2":"0"}}))}});
  });
  t.after(()=>mock.restoreAll());
  const send = async (path,data={},token) => {
    const got = await worker.fetch(new Request("https://test.invalid"+path,{
      method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{})},
      body:JSON.stringify(data)
    }),env);
    return {status:got.status,body:await got.json()};
  };
  const start = async () => {
    const got = await send("/auth/start");
    assert.equal(got.status,200);
    assert.equal(new URL(got.body.url).origin,"https://www.last.fm");
    assert.equal(new URL(got.body.url).searchParams.get("api_key"),"app-key");
    return got.body;
  };
  const pair = async (name) => {
    const {attempt,url} = await start();
    assert.equal((await send("/auth/finish",{attempt})).status,409);
    approved.set(new URL(url).searchParams.get("token"),name);
    const linked = await send("/auth/finish",{attempt});
    assert.equal(linked.status,200);
    assert.equal(linked.body.name,name);
    assert.equal((await send("/auth/finish",{attempt})).status,410);
    return linked.body.token;
  };
  assert.equal((await send("/arbitrary")).status,404);
  assert.equal((await send("/recent")).status,401);
  rateLimited = true;
  assert.equal((await send("/auth/start")).status,429);
  assert.equal(calls.length,0);
  rateLimited = false;
  const alice = await pair("Alice"), bob = await pair("Bob");
  assert.notEqual(alice,bob);
  for (const row of db.prepare("SELECT * FROM sessions").all()) {
    assert.ok(![alice,bob].includes(row.token_hash));
    assert.doesNotMatch(row.sealed_key,/private-/);
  }
  assert.equal((await send("/recent",{user:"VJRadio",limit:201,page:1},alice)).status,400);
  assert.equal((await send("/recent",{user:"VJRadio",limit:1,page:1},alice)).body.recenttracks.track[0].name,"Example");
  outage = true;
  assert.deepEqual(await send("/recent",{user:"VJRadio",limit:1,page:1},alice),
    {status:503,body:{error:"Last.fm is temporarily unavailable. Try again later.",code:8}});
  const item = {artist:"Björk",title:"Jóga",ts:Math.floor(Date.now()/1000)-60};
  const rows = Array.from({length:11},(_,i)=>({...item,title:item.title+" "+i}));
  assert.equal((await send("/scrobble",{rows:Array(51).fill(item),live:false},alice)).status,400);
  const batch = await send("/scrobble",{rows,live:true,sk:"private-Bob",username:"Bob"},alice);
  assert.equal(batch.status,200);
  assert.equal(batch.body.codes[1],2);
  assert.equal(calls.at(-1).sk,"private-Alice");
  assert.equal(calls.at(-1)["track[10]"],"Jóga 10");
  assert.equal(calls.at(-1)["chosenByUser[10]"],"0");
  assert.equal((await send("/disconnect",{},alice)).status,200);
  assert.equal((await send("/scrobble",{rows:[item],live:false},alice)).status,401);
  assert.equal((await send("/scrobble",{rows:[item],live:false},bob)).status,200);
  assert.equal(calls.at(-1).sk,"private-Bob");
  invalidSession = true;
  assert.equal((await send("/scrobble",{rows:[item],live:false},bob)).status,401);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n,0);
  const {attempt} = await start();
  db.exec("UPDATE connections SET expires_at = 0");
  assert.equal((await send("/auth/finish",{attempt})).status,410);
  await start();
  assert.equal(db.prepare("SELECT count(*) AS n FROM connections").get().n,1);
});
