// Kendi kendine test: iki istemci baglanir, hizli odaya katilir, konum gonderir, birbirini gorur.
const WebSocket = require('ws');
const URL = 'ws://localhost:' + (process.env.PORT || 18080);
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const results = {};
function client(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const c = { ws, name, id: 0, got: { snap: 0, pj: 0, pl: 0 }, joined: null, rooms: null, players: [] };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, bike: 3 })));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'welcome') { c.id = m.id; }
      if (m.t === 'rooms') { c.rooms = m.rooms; resolve(c); }
      if (m.t === 'joined') { c.joined = m; c.players = m.players; }
      if (m.t === 'snap') { c.got.snap++; c.last = m.p; }
      if (m.t === 'pj') c.got.pj++;
      if (m.t === 'pl') c.got.pl++;
    });
    ws.on('error', (e) => fail('baglanti: ' + e.message));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const a = await client('Kaan T.');
  const b = await client('Emma R.');
  if (!a.rooms || a.rooms.length < 2) fail('varsayilan odalar yok');
  a.ws.send(JSON.stringify({ t: 'quick' })); await wait(150);
  b.ws.send(JSON.stringify({ t: 'quick' })); await wait(150);
  if (!a.joined || !b.joined) fail('quick join calismadi');
  if (a.joined.room.id !== b.joined.room.id) fail('iki oyuncu ayni odaya girmedi');
  if (b.players.length !== 1 || b.players[0].name !== 'Kaan T.') fail('oyuncu listesi hatali');
  for (let i = 0; i < 8; i++) {
    a.ws.send(JSON.stringify({ t: 's', x: 10 + i, y: 0, z: 5, ry: 90, lz: 12, sp: 20, st: 3 }));
    b.ws.send(JSON.stringify({ t: 's', x: -10, y: 0, z: 5 + i, ry: 0, lz: 0, sp: 5, st: 0 }));
    await wait(60);
  }
  await wait(300);
  if (a.got.snap < 3 || b.got.snap < 3) fail('snapshot gelmiyor');
  if (!b.last.find((p) => p.id === a.id && p.sp === 20)) fail('rakip durumu snapshot icinde yok');
  if (a.got.pj !== 1) fail('player-joined bildirimi gelmedi');
  // gecersiz veri kirpilir
  a.ws.send(JSON.stringify({ t: 's', x: 'abc', y: 1e9, z: NaN, sp: 9999 })); await wait(250);
  const bad = b.last.find((p) => p.id === a.id);
  if (!bad || bad.sp > 100 || bad.y > 2000) fail('dogrulama kirpmiyor');
  // oda kur / katil / ayril
  b.ws.send(JSON.stringify({ t: 'create', name: 'Ozel', max: 4 })); await wait(150);
  if (b.joined.room.name !== 'Ozel' || a.got.pl !== 1) fail('oda kurma/ayrilma bildirimi hatali');
  const code = b.joined.room.id;
  a.ws.send(JSON.stringify({ t: 'join', room: code.toLowerCase() })); await wait(150);
  if (a.joined.room.id !== code) fail('kodla katilma calismadi');
  a.ws.close(); b.ws.close();
  console.log('PASS: tum coklu oyuncu testleri gecti');
  process.exit(0);
})();
