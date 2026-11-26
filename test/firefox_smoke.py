import http.client, json, math, os, pathlib, socket, struct, subprocess, tempfile, time, wave, zipfile
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from threading import Thread

directory = pathlib.Path(__file__).resolve().parents[1]
uuid='174ce124-41d5-488f-b50a-2f072403838d'
addon='firefox-scrobbler@murtazarang.github.io'
with socket.socket() as port_probe:
    port_probe.bind(("127.0.0.1", 0))
    port = port_probe.getsockname()[1]
p = subprocess.Popen([os.environ.get("GECKODRIVER", "geckodriver"), "--port", str(port), "--log",
                      "error", "--allow-system-access"],
                     env={**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"})
sid=None
def req(method,path,data=None):
    c=http.client.HTTPConnection('127.0.0.1',port,timeout=65)
    c.request(method,path,json.dumps(data).encode() if data is not None else None,{'Content-Type':'application/json'})
    r=c.getresponse(); body=json.loads(r.read())['value']
    if r.status>=400: raise RuntimeError(str(body))
    return body
def run():
    global sid
    for _ in range(50):
        try: req('GET','/status'); break
        except ConnectionError: time.sleep(.2)
    sid=req('POST','/session',{'capabilities':{'alwaysMatch':{'browserName':'firefox','moz:firefoxOptions':{
      'binary':os.environ.get("FIREFOX", "/usr/bin/firefox"), 'args':['-headless'],
      'prefs':{'extensions.webextensions.uuids':json.dumps({addon:uuid}),'media.autoplay.default':0}}}}})['sessionId']
    base='/session/'+sid
    def js(source,*args): return req('POST',base+'/execute/sync',{'script':source,'args':args})
    def async_js(source,*args): return req('POST',base+'/execute/async',{'script':source,'args':args})
    def go(url):
        req('POST',base+'/moz/context',{'context':'chrome'})
        try:
            js('const w=Services.wm.getMostRecentWindow("navigator:browser"); w.gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]),{triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});',url)
        finally: req('POST',base+'/moz/context',{'context':'content'})
        time.sleep(.55)
    def pack(out):
        with zipfile.ZipFile(out,'w') as z:
            for f in (directory/'extension').iterdir():
                data=f.read_bytes()
                z.writestr(f.name,data)
    with tempfile.TemporaryDirectory() as tmp:
        tmp=pathlib.Path(tmp); xpi=tmp/'exact.xpi'; pack(xpi)
        assert req('POST',base+'/moz/addon/install',{'path':str(xpi),'temporary':True})==addon
        root='moz-extension://'+uuid
        go(root+'/panel.html?settings')
        assert js("return typeof browser.permissions.request")=='function'
        assert js("return document.querySelector('#options').hidden") is False
        assert js("return document.querySelector('#account').textContent") == 'Last.fm not connected'
        js("document.querySelector('#profiles').value='https://www.last.fm/user/Example'; document.querySelector('#save').click()")
        time.sleep(.4)
        assert js("return document.querySelector('#status').textContent") == 'Settings saved.'
        go(root+'/panel.html')
        assert js("return document.querySelector('#profile').value")=='example'
        assert js("return document.querySelector('#actions').hidden") is False
        header = "Play\tAlbum\tLoved\tTrack name\tArtist name\tBuy\tOptions\tTimestamp"
        clipboard = header + "\n" + "\n".join(
            f"\nAlbum\nFixture doesn't love this track\nSong {i+1}\tArtist\nBuy\nMore\n4 hours ago"
            for i in range(50)
        )
        js("""
            document.querySelector('#manualPlays').open = true;
            const text = document.querySelector('#pastedPlays');
            text.value = arguments[0];
            text.dispatchEvent(new Event('input', {bubbles:true}));
            document.querySelector('#previewPaste').click();
        """, clipboard)
        assert js("""return [
            document.querySelector('#playPreview').open,
            document.querySelector('#copy').hidden,
            document.querySelector('#copyAll').textContent,
            document.querySelectorAll('#list .track').length
        ]""") == [False, True, 'Scrobble all (50)', 50]
        assert '(estimated)' in js("return document.querySelector('#list .track').textContent")
        h=ThreadingHTTPServer(('127.0.0.1',0),partial(SimpleHTTPRequestHandler,directory=tmp))
        Thread(target=h.serve_forever,daemon=True).start()
        (tmp/'page.html').write_text('<title>Audio fixture</title><audio src="tone.wav" autoplay loop controls></audio>')
        with wave.open(str(tmp/'tone.wav'),'wb') as w:
            w.setparams((1,2,16000,0,'NONE','not compressed'))
            w.writeframes(b''.join(struct.pack('<h',int(6000*math.sin(i*2*math.pi*450/16000))) for i in range(16000*14)))
        req('POST',base+'/url',{'url':f'http://127.0.0.1:{h.server_port}/page.html'})
        req('POST',base+'/timeouts',{'script':22000})
        source=(directory/'extension/panel.js').read_text()
        capture=source[source.index('function recordPlayer()'):source.index('\nif (settings)')]
        clip=async_js(capture+"""
          const done=arguments[arguments.length-1];
          document.querySelector('audio').play().then(recordPlayer).then(x=>done({length:x.data?.length,type:x.type,error:x.error}), e=>done({error:String(e)}));
        """)
        assert clip.get('length',0)>10000 and clip['type'].startswith('audio/'), clip
        print('Firefox: temporary add-on installed; settings saved and read by popup; 50 raw pasted plays previewed without a submission. Capture function recorded synthetic HTML audio locally. No live credentials or uploads.')
try:
    run()
finally:
    if sid:
        try: req('DELETE','/session/'+sid)
        except Exception: pass
    p.terminate()
    p.wait(timeout=10)
