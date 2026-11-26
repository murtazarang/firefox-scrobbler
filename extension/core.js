"use strict";

const Scrobble = (() => {
  // Last.fm requires MD5 for its API signature, not for password storage.
  function md5(value) {
    const bytes = new TextEncoder().encode(value);
    const n = Math.ceil((bytes.length + 9) / 64) * 64;
    const data = new DataView(new ArrayBuffer(n));
    new Uint8Array(data.buffer).set(bytes);
    data.setUint8(bytes.length, 128);
    data.setUint32(n - 8, bytes.length * 8, true);
    data.setUint32(n - 4, Math.floor(bytes.length / 0x20000000), true);
    const k = Array.from({length: 64}, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
    const shifts = [[7,12,17,22],[5,9,14,20],[4,11,16,23],[6,10,15,21]];
    let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    for (let p = 0; p < n; p += 64) {
      let A = a, B = b, C = c, D = d;
      for (let i = 0; i < 64; i++) {
        const round = i >> 4, s = shifts[round][i % 4];
        const f = [(B & C) | (~B & D), (D & B) | (~D & C), B ^ C ^ D, C ^ (B | ~D)][round];
        const g = [i, (5*i+1)%16, (3*i+5)%16, (7*i)%16][round];
        const t = (A + f + k[i] + data.getInt32(p + 4*g, true)) | 0;
        [A, B, C, D] = [D, (B + ((t << s) | (t >>> (32-s)))) | 0, B, C];
      }
      a = (a+A)|0; b = (b+B)|0; c = (c+C)|0; d = (d+D)|0;
    }
    return [a,b,c,d].flatMap(x => [0,8,16,24].map(s => ((x >>> s) & 255).toString(16).padStart(2,"0"))).join("");
  }
  const signature = (params, secret) => md5(Object.keys(params).filter(k => k !== "format" && k !== "callback" && k !== "api_sig").sort().map(k => k + params[k]).join("") + secret);
  function nameFromUrl(value, kind) {
    try {
      const u = new URL(value);
      if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
      if (kind === "twitch" && ["www.twitch.tv","twitch.tv"].includes(u.hostname))
        return /^\/([a-z0-9_]{1,25})\/?$/i.exec(u.pathname)?.[1].toLowerCase() || null;
      if (kind === "lastfm" && ["www.last.fm","last.fm"].includes(u.hostname))
        return /^\/user\/([a-z0-9_-]{1,64})\/?$/i.exec(u.pathname)?.[1].toLowerCase() || null;
    } catch {}
    return null;
  }
  function parseTrack(t) {
    const artist = (t.artist?.["#text"] || t.artist?.name || "").trim();
    const title = (t.name || "").trim();
    const now = t["@attr"]?.nowplaying === "true";
    const ts = Number(t.date?.uts);
    if (!artist || !title || (!now && (!Number.isSafeInteger(ts) || ts <= 0))) return null;
    return {artist, title, album: t.album?.["#text"] || "", ts: now ? null : ts, now};
  }
  function key(t) {
    return JSON.stringify([t.artist.trim().normalize("NFC").toLowerCase(),t.title.trim().normalize("NFC").toLowerCase(),t.ts]);
  }
  function updateWindows(previous, tabs, mappings, now) {
    const visible = new Set(tabs.map(t => nameFromUrl(t.url, "twitch")).filter(Boolean));
    const handles = new Set(mappings.filter(m => m.enabled && visible.has(m.channel)).map(m => m.profile));
    return Object.fromEntries([...handles].map(profile => [profile, previous[profile] || {since: now, from: now}]));
  }
  return {md5, signature, nameFromUrl, parseTrack, key, updateWindows};
})();
if (typeof module !== "undefined") module.exports = Scrobble;
