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
  function parsePastedPlays(text, now = Math.floor(Date.now()/1000)) {
    const cells = text.split(/[\t\r\n]+/).map(x => x.trim()).filter(Boolean);
    if (cells.slice(0,8).join("|") === "Play|Album|Loved|Track name|Artist name|Buy|Options|Timestamp")
      cells.splice(0,8);
    const loved = / (?:doesn['’]t love|does not love|loves) this track$/i;
    if (cells.some(cell => loved.test(cell))) {
      const rows = [];
      for (let start = 0; start < cells.length;) {
        const offset = cells.slice(start,start+3).findIndex(cell => loved.test(cell));
        const marker = offset < 0 ? -1 : start+offset;
        if (marker < 0) throw Error(`Play ${rows.length+1}: copy complete rows from the Last.fm Recent Tracks table.`);
        const [,title,artist,buy,more,stamp] = cells.slice(marker,marker+6);
        const age = /^(\d+) (second|minute|hour|day|week)s? ago$/i.exec(stamp || "");
        if (!title || !artist || buy !== "Buy" || more !== "More" || !age)
          throw Error(`Play ${rows.length+1}: expected a complete row with a time like “4 hours ago”. For exact times, use Artist | Track | Timestamp.`);
        const unit = {second:1,minute:60,hour:3600,day:86400,week:604800}[age[2].toLowerCase()];
        const ts = now - Number(age[1])*unit;
        if (!Number.isSafeInteger(ts) || ts <= 0) throw Error(`Play ${rows.length+1}: invalid timestamp.`);
        const album = cells.slice(start,marker).find(cell => cell !== "Play track");
        rows.push({artist,title,ts,approximate:true,...(album ? {album} : {})});
        if (rows.length > 1000) throw Error("Paste no more than 1,000 plays at a time.");
        start = marker+6;
      }
      return rows;
    }
    const lines = text.split(/\r?\n/).map((raw,i) => ({raw, number:i+1})).filter(x => x.raw.trim());
    if (!lines.length) throw Error("Paste at least one play.");
    if (lines.length > 1000) throw Error("Paste no more than 1,000 plays at a time.");
    return lines.map(({raw,number}) => {
      const parts = raw.split(raw.includes("\t") ? "\t" : "|").map(x => x.trim());
      const [artist,title,stamp] = parts;
      if (parts.length !== 3 || !artist || !title)
        throw Error(`Line ${number}: use Artist | Track | Timestamp (tabs also work).`);
      let ts;
      if (/^\d{1,10}$/.test(stamp)) {
        ts = Number(stamp);
      } else {
        const date = /^(\d{4})-(\d{2})-(\d{2})T\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.exec(stamp);
        if (date && stamp.slice(11,13) !== "24") {
          const [,year,month,day] = date.map(Number);
          const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
          const monthDays = [31, leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
          if (day > 0 && day <= monthDays[month-1]) ts = Date.parse(stamp)/1000;
        }
      }
      if (!Number.isSafeInteger(ts) || ts <= 0)
        throw Error(`Line ${number}: enter Unix seconds or an exact date and time with a timezone.`);
      return {artist,title,ts};
    });
  }
  function key(t) {
    return JSON.stringify([t.artist.trim().normalize("NFC").toLowerCase(),t.title.trim().normalize("NFC").toLowerCase(),t.ts]);
  }
  function updateWindows(previous, tabs, mappings, now) {
    const visible = new Set(tabs.map(t => nameFromUrl(t.url, "twitch")).filter(Boolean));
    const handles = new Set(mappings.filter(m => m.enabled && visible.has(m.channel)).map(m => m.profile));
    return Object.fromEntries([...handles].map(profile => [profile, previous[profile] || {since: now, from: now}]));
  }
  return {md5, signature, nameFromUrl, parseTrack, parsePastedPlays, key, updateWindows};
})();
if (typeof module !== "undefined") module.exports = Scrobble;
