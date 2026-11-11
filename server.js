// MotoMeta Game - coklu oyuncu sunucusu (prototip)
// WebSocket + odalar + konum aktarimi. Render (ucretsiz) ve GitHub ile calisir.
// Not: sunucu su an SADECE konumlari aktarir ve temel dogrulama yapar (sayi/aralik/hiz siniri).
// Siralama tablolari (en iyi tur / toplam sure / elmas) ve online yaris odalari (lobi + bot doldurma) eklendi.
// Sureler sunucu saatiyle dogrulanir: istemci 'racestart' gonderir, 'submit' suresi gecen gercek sureyle ve
// pistin fiziksel alt sinirIyla tutarli olmalidir.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_CLIENTS = 300;
const MAX_ROOM = 16;
const TICK_MS = 100;          // 10 Hz snapshot
const MAX_SPEED = 100;        // m/s, ustu kirpilir
const MAX_MSG_PER_SEC = 40;
const LOBBY_MS = Number(process.env.LOBBY_MS) || 30000;      // yaris odasinda gercek oyuncu bekleme suresi (sonra bot doldurulur)


// ---------------- Siralama tablolari ----------------
const TRACK_LEN = [1284, 1492, 1779, 1092, 2098, 1459];     // pist uzunluklari (m)
const MAX_RACE_SPEED = Number(process.env.MAX_RACE_SPEED) || 92;                // m/s: ustu fiziksel olarak imkansiz say
const DATA_FILE = path.join(__dirname, 'boards.json');
const NTRACKS = TRACK_LEN.length;
const boards = { lap: TRACK_LEN.map(() => ({})), total: TRACK_LEN.map(() => ({})), gems: {} };   // pid -> { n, v, ts }
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (raw && raw.lap && raw.total && raw.gems) {
    for (let i = 0; i < NTRACKS; i++) { if (raw.lap[i]) boards.lap[i] = raw.lap[i]; if (raw.total[i]) boards.total[i] = raw.total[i]; }
    boards.gems = raw.gems;
  }
} catch (e) { /* ilk calistirma */ }
let dirty = false;
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  fs.writeFile(DATA_FILE, JSON.stringify(boards), () => {});
}, 20000);

function cleanName(s, def) {
  return String(s || def || 'Rider').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 20) || def || 'Rider';
}
function topRows(map, asc, n) {
  const rows = Object.entries(map).map(([pid, r]) => ({ n: r.n, v: r.v, pid }));
  rows.sort((a, b) => (asc ? a.v - b.v : b.v - a.v));
  return rows.slice(0, n);
}
function rankOf(map, pid, asc) {
  const rows = topRows(map, asc, 100000);
  const i = rows.findIndex((r) => r.pid === pid);
  return i < 0 ? 0 : i + 1;
}
function updateBest(map, pid, name, v, asc) {
  const cur = map[pid];
  if (!cur || (asc ? v < cur.v : v > cur.v)) { map[pid] = { n: name, v, ts: Date.now() }; dirty = true; }
  else if (cur.n !== name) { cur.n = name; dirty = true; }
}
function boardFor(key) {
  if (key === 'gems') return { map: boards.gems, asc: false };
  const tr = Math.min(NTRACKS - 1, Math.max(0, parseInt(String(key).replace('lap', '').replace('total', ''), 10) || 0));
  return String(key).startsWith('total') ? { map: boards.total[tr], asc: true } : { map: boards.lap[tr], asc: true };
}

// Gizlilik politikasi sayfasi (Play Console'a bu adresi yaz: https://<sunucu>/privacy)
const CONTACT_NAME = process.env.CONTACT_NAME || '[AD SOYAD / UNVAN]';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || '[E-POSTA]';
let PRIVACY_HTML = '';
try {
  PRIVACY_HTML = fs.readFileSync(path.join(__dirname, 'privacy.html'), 'utf8')
    .replace(/\{\{NAME\}\}/g, CONTACT_NAME).replace(/\{\{EMAIL\}\}/g, CONTACT_EMAIL)
    .replace(/\{\{DATE\}\}/g, new Date().toISOString().slice(0, 10));
} catch (e) { PRIVACY_HTML = '<p>privacy.html bulunamadi</p>'; }

const server = http.createServer((req, res) => {
  if ((req.url || '').split('?')[0] === '/privacy') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PRIVACY_HTML);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('MotoMeta server OK  |  players: ' + clients.size + '  rooms: ' + rooms.size + '\n');
});
const wss = new WebSocketServer({ server, maxPayload: 4096 });

let nextId = 1;
const clients = new Map();   // ws -> client
const rooms = new Map();     // id -> room

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(c) ? genCode() : c;
}

function createRoom(name, max, mode, persistent, id) {
  const room = { id: id || genCode(), name: String(name || 'Oda').slice(0, 24), max: Math.min(MAX_ROOM, Math.max(2, max | 0 || 8)),
    mode: mode === 'race' ? 'race' : 'free', members: new Set(), persistent: !!persistent,
    track: 0, phase: 'lobby', lobbyEnd: Date.now() + LOBBY_MS, goAt: 0 };
  rooms.set(room.id, room);
  return room;
}
createRoom('Sehir 1', 16, 'free', true, 'SEHIR1');
createRoom('Sehir 2', 16, 'free', true, 'SEHIR2');

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const roomInfo = (r) => ({ id: r.id, name: r.name, count: r.members.size, max: r.max, mode: r.mode, track: r.track, phase: r.phase });
const num = (v, lo, hi, def) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };

function listRooms() { return [...rooms.values()].map(roomInfo); }

function leaveRoom(c) {
  const r = c.room;
  if (!r) return;
  r.members.delete(c);
  c.room = null;
  for (const m of r.members) send(m.ws, { t: 'pl', id: c.id });
  if (r.members.size === 0 && !r.persistent) rooms.delete(r.id);
}

function joinRoom(c, r) {
  if (!r) return send(c.ws, { t: 'err', m: 'room_not_found' });
  if (r.members.size >= r.max) return send(c.ws, { t: 'err', m: 'room_full' });
  if (r.mode === 'race' && r.phase !== 'lobby') return send(c.ws, { t: 'err', m: 'race_started' });
  leaveRoom(c);
  r.members.add(c);
  c.room = r;
  c.state = null;
  const players = [...r.members].filter((m) => m !== c).map((m) => ({ id: m.id, name: m.name, bike: m.bike }));
  send(c.ws, { t: 'joined', room: roomInfo(r), you: c.id, players });
  for (const m of r.members) if (m !== c) send(m.ws, { t: 'pj', id: c.id, name: c.name, bike: c.bike });
}

wss.on('connection', (ws) => {
  if (clients.size >= MAX_CLIENTS) { ws.close(1013, 'busy'); return; }
  const c = { ws, id: nextId++, name: 'Rider' + Math.floor(Math.random() * 900 + 100), bike: 0, room: null, state: null,
    alive: true, tokens: MAX_MSG_PER_SEC, last: Date.now(), pid: 'anon' + nextId, raceT0: 0, gemsClaimed: 0, gemsAt: Date.now(), t0: Date.now() };
  clients.set(ws, c);
  send(ws, { t: 'welcome', id: c.id });

  ws.on('pong', () => { c.alive = true; });

  ws.on('message', (data) => {
    // basit hiz siniri
    const now = Date.now();
    c.tokens = Math.min(MAX_MSG_PER_SEC, c.tokens + ((now - c.last) / 1000) * MAX_MSG_PER_SEC);
    c.last = now;
    if (c.tokens < 1) return;
    c.tokens -= 1;

    let m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'hello':
        c.name = cleanName(m.name, c.name);
        if (typeof m.pid === 'string' && /^[A-Za-z0-9\-]{8,48}$/.test(m.pid)) c.pid = m.pid;
        c.bike = num(m.bike, 0, 99, 0) | 0;
        send(ws, { t: 'rooms', rooms: listRooms() });
        break;
      case 'list':
        send(ws, { t: 'rooms', rooms: listRooms() });
        break;
      case 'quick': {
        let best = null;
        for (const r of rooms.values())
          if (r.mode === 'free' && r.members.size < r.max && (!best || r.members.size > best.members.size)) best = r;
        joinRoom(c, best || createRoom('Hizli oda', 8, 'free', false));
        break;
      }
      case 'create':
        joinRoom(c, createRoom(m.name, m.max, m.mode, false));
        break;
      case 'join':
        joinRoom(c, rooms.get(String(m.room || '').toUpperCase()));
        break;
      case 'leave':
        leaveRoom(c);
        break;
      case 's': {   // durum: konum, yon, egim, hiz, direksiyon
        if (!c.room) break;
        c.state = {
          id: c.id,
          x: num(m.x, -50000, 50000, 0), y: num(m.y, -100, 2000, 0), z: num(m.z, -50000, 50000, 0),
          ry: num(m.ry, -720, 720, 0), lz: num(m.lz, -90, 90, 0),
          sp: num(m.sp, -MAX_SPEED, MAX_SPEED, 0), st: num(m.st, -60, 60, 0), b: c.bike
        };
        break;
      }
      case 'quickrace': {   // online yaris: ayni pistte lobideki odaya gir, yoksa olustur
        const track = num(m.track, 0, NTRACKS - 1, 0) | 0;
        let best = null;
        for (const r of rooms.values())
          if (r.mode === 'race' && r.track === track && r.phase === 'lobby' && r.members.size < r.max && (!best || r.members.size > best.members.size)) best = r;
        if (!best) { best = createRoom('Yaris ' + (track + 1), 8, 'race', false); best.track = track; }
        joinRoom(c, best);
        break;
      }
      case 'racestart':   // istemci geri sayim bittiginde bildirir: sure dogrulamasi icin sunucu saati baslar
        c.raceT0 = Date.now();
        break;
      case 'submit': {    // yaris sonucu (sure dogrulamali)
        const track = num(m.track, 0, NTRACKS - 1, 0) | 0;
        const laps = num(m.laps, 1, 10, 1) | 0;
        const lap = num(m.lap, 0, 36000, 0);
        const total = num(m.total, 0, 36000, 0);
        const minLap = TRACK_LEN[track] / MAX_RACE_SPEED;
        const elapsed = c.raceT0 ? (Date.now() - c.raceT0) / 1000 : 0;
        let why = '';
        if (!c.raceT0) why = 'no_race';
        else if (lap < minLap * 0.97 || total < minLap * 0.97 * laps || total < lap) why = 'too_fast';
        else if (total < elapsed - 4) why = 'time_mismatch';       // gercekte gecen sureden cok kisa iddia
        else if (total > elapsed + 3) why = 'time_mismatch';
        if (why) { send(ws, { t: 'sub', ok: false, why }); break; }
        c.raceT0 = 0;
        const nm = c.name;
        updateBest(boards.lap[track], c.pid, nm, lap, true);
        if (laps === 3) updateBest(boards.total[track], c.pid, nm, total, true);
        send(ws, { t: 'sub', ok: true, rankLap: rankOf(boards.lap[track], c.pid, true), rankTotal: laps === 3 ? rankOf(boards.total[track], c.pid, true) : 0 });
        if (c.room && c.room.mode === 'race')
          for (const mm of c.room.members) send(mm.ws, { t: 'fin', id: c.id, name: nm, time: total });
        break;
      }
      case 'gems': {      // toplam elmas puani (hiz sinirli)
        const total = num(m.total, 0, 1e7, 0) | 0;
        const now = Date.now();
        const secs = (now - c.gemsAt) / 1000;
        const cap = c.gemsClaimed ? c.gemsClaimed + secs * 3 + 25 : 3000 + (now - c.t0) / 1000 * 3;
        if (total > cap || total < c.gemsClaimed) { send(ws, { t: 'sub', ok: false, why: 'gems_rate' }); break; }
        c.gemsClaimed = total; c.gemsAt = now;
        updateBest(boards.gems, c.pid, c.name, total, false);
        send(ws, { t: 'sub', ok: true, rankLap: 0, rankTotal: 0, rankGems: rankOf(boards.gems, c.pid, false) });
        break;
      }
      case 'lb': {        // siralama tablosu iste: 'lap0'..'lap2', 'total0'..'total2', 'gems'
        const key = String(m.key || 'lap0').slice(0, 8);
        const b = boardFor(key);
        send(ws, { t: 'lb', key, rows: topRows(b.map, b.asc, 10).map((r) => ({ n: r.n, v: r.v, me: r.pid === c.pid })), myRank: rankOf(b.map, c.pid, b.asc) });
        break;
      }
      case 'hit': {       // carpma olayi: odadaki herkese ilet (hedefte hasar/parca, digerlerinde gorsel)
        if (!c.room) break;
        const now = Date.now();
        if (now - (c.lastHit || 0) < 400) break;       // hiz siniri
        c.lastHit = now;
        const target = num(m.target, 0, 1e9, -1) | 0;
        let tm = null;
        for (const mm of c.room.members) if (mm.id === target) tm = mm;
        if (!tm || tm === c) break;
        const out = { t: 'hit', a: c.id, b: target, sev: num(m.sev, 0, 1, 0.3),
          x: num(m.x, -1e5, 1e5, 0), y: num(m.y, -1e3, 1e3, 0), z: num(m.z, -1e5, 1e5, 0) };
        for (const mm of c.room.members) send(mm.ws, out);
        break;
      }
      case 'forget': {    // KVKK/GDPR silme talebi: bu kimlige ait tum kayitlari sil
        let n = 0;
        for (const arr of [boards.lap, boards.total]) for (const mp of arr) if (mp[c.pid]) { delete mp[c.pid]; n++; }
        if (boards.gems[c.pid]) { delete boards.gems[c.pid]; n++; }
        dirty = true;
        c.gemsClaimed = 0;
        c.pid = 'anon' + c.id + '-' + Date.now();
        send(ws, { t: 'forgot', removed: n });
        break;
      }
      case 'ping':
        send(ws, { t: 'pong', ts: m.ts });
        break;
    }
  });

  ws.on('close', () => { leaveRoom(c); clients.delete(ws); });
  ws.on('error', () => {});
});

// 10 Hz snapshot: her odada guncel durumlari topla ve uyelere gonder
setInterval(() => {
  for (const r of rooms.values()) {
    if (r.members.size < 2) continue;
    const p = [];
    for (const m of r.members) if (m.state) p.push(m.state);
    if (p.length === 0) continue;
    const msg = JSON.stringify({ t: 'snap', p });
    for (const m of r.members) if (m.ws.readyState === 1) m.ws.send(msg);
  }
}, TICK_MS);


// Yaris lobisi: 1 sn'de bir kalan sure; sure dolunca veya oda dolunca baslat (bos yerleri istemciler botla doldurur)
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.mode !== 'race' || r.members.size === 0) continue;
    if (r.phase === 'lobby') {
      const left = Math.max(0, Math.ceil((r.lobbyEnd - now) / 1000));
      if (left <= 0 || r.members.size >= r.max) {
        r.phase = 'run';
        r.goAt = now + 6000;
        const bots = Math.max(0, r.max - r.members.size);
        const seed = Math.floor(Math.random() * 1e6);
        for (const m of r.members) send(m.ws, { t: 'rgo', in: 6, bots, seed, humans: r.members.size });
      } else {
        for (const m of r.members) send(m.ws, { t: 'lobby', left, humans: r.members.size, max: r.max });
      }
    }
  }
}, 1000);

// Render ucretsiz plan uzun sessizlikte baglantiyi kesebilir: 25 sn'de bir ping
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    c.ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log('MotoMeta server listening on :' + PORT));
