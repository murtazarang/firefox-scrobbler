const test = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const vm = require("node:vm");

async function popup({account = "listener", result = {artist:"Artist", title:"Song"}} = {}) {
  class Element {
    listeners = {};
    children = [];
    hidden = false;
    textContent = "";
    addEventListener(k,fn){ this.listeners[k] = fn; }
    replaceChildren(...children){ this.children = children; }
    append(child){ this.children.push(child); }
    click(){ return this.disabled ? undefined : this.listeners.click(); }
  }
  const elements = new Map();
  const $ = id => {
    if (!elements.has(id)) elements.set(id,new Element());
    return elements.get(id);
  };
  const calls = [];
  let captures = 0, lookups = 0;
  const browser = {
    runtime:{
      async sendMessage(m){
        calls.push(m);
        if (m.action === "status") return {data:{account,config:{profiles:[], hasRecognition:true},active:[]}};
        if (m.action === "submit") return {data:{accepted:1,skipped:0,rejected:0,uncertain:0,codes:[]}};
      }
    },
    permissions:{contains:async()=>true},
    tabs:{query:async()=>[{id:4}]},
    scripting:{executeScript:async () => {
      captures++;
      return [{result:{data:"YWJj",type:"audio/webm"}}];
    }},
    storage:{local:{get:async()=>({config:{auddToken:"test"}})}}
  };
  const document = {getElementById:$,createElement:()=>new Element(),body:{classList:{add(){}}}};
  vm.runInNewContext(readFileSync("extension/panel.js","utf8"),{
    document,browser,location:{search:""},URLSearchParams,AbortSignal,atob,Blob,FormData,
    fetch:async()=>{ lookups++; return {ok:true,json:async()=>({status:"success",result})}; }
  });
  await new Promise(resolve => setImmediate(resolve));
  calls.length = 0;
  return {$,calls,counts:()=>[captures,lookups]};
}

test("Identify previews the match and only submits when Scrobble match is clicked",async()=>{
  const p = await popup();
  await p.$("identify").click();
  assert.equal(p.$("match").children[0].textContent,"Artist — Song");
  assert.equal(p.$("scrobble").hidden,false);
  assert.deepEqual(p.calls,[]);
  await p.$("scrobble").click();
  assert.equal(p.calls[0].action,"submit");
  assert.equal(p.calls[0].rows[0].title,"Song");
});

test("Identify & scrobble submits the detected song once and shows the result",async()=>{
  const p = await popup();
  const task = p.$("identifyAndScrobble").click();
  assert.equal(p.$("identify").disabled,true);
  await task;
  assert.deepEqual(p.calls.map(m=>m.action),["status","submit"]);
  assert.equal(p.$("scrobble").hidden,true);
  assert.match(p.$("status").textContent,/Submitted: 1/);
  assert.deepEqual(p.counts(),[1,1]);
});

test("Identify & scrobble does not submit without a match, or record without a Last.fm account",async()=>{
  const noMatch = await popup({result:null});
  await noMatch.$("identifyAndScrobble").click();
  assert.deepEqual(noMatch.calls.map(m=>m.action),["status"]);
  assert.match(noMatch.$("status").textContent,/Nothing was scrobbled/);
  const noAccount = await popup({account:null});
  await noAccount.$("identifyAndScrobble").click();
  assert.deepEqual(noAccount.counts(),[0,0]);
  assert.match(noAccount.$("status").textContent,/Connect your Last.fm/);
});
