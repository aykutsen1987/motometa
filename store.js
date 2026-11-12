// MotoMeta - siralama / kayit deposu.
//  - DATABASE_URL varsa: PostgreSQL (Neon). Silme (forget) ve saklama suresi (RETENTION_DAYS, varsayilan 365 gun) veritabaninda calisir.
//  - Yoksa (veya baglanti kurulamazsa): bellek + boards.json dosyasi (Render ucretsiz planda yeniden baslatinca silinir).
// Satir modeli: kind = 'lap' | 'total' | 'gems', track = pist no (gems icin 0), pid = cihaz kimligi, name = takma ad, v = deger.
const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 365;

// ---------------------------------------------------------------- bellek (+ dosya) deposu
function createMemoryStore(nTracks) {
  const file = path.join(__dirname, 'boards.json');
  const data = {};            // 'kind:track' -> { pid: { n, v, ts } }
  const key = (kind, track) => kind + ':' + (kind === 'gems' ? 0 : track);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.mem) Object.assign(data, raw.mem);
  } catch (e) { /* ilk calistirma */ }
  let dirty = false;
  const timer = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    fs.writeFile(file, JSON.stringify({ mem: data }), () => {});
  }, 20000);
  timer.unref();
  const map = (kind, track) => (data[key(kind, track)] = data[key(kind, track)] || {});
  return {
    name: 'memory',
    async init() {},
    async getRow(kind, track, pid) { const r = map(kind, track)[pid]; return r ? { v: r.v, ts: r.ts } : null; },
    async updateBest(kind, track, pid, name, v, asc) {
      const m = map(kind, track), cur = m[pid];
      if (!cur) m[pid] = { n: name, v, ts: Date.now() };
      else { if (asc ? v < cur.v : v > cur.v) cur.v = v; cur.n = name; cur.ts = Date.now(); }
      dirty = true;
    },
    async top(kind, track, asc, n) {
      const rows = Object.entries(map(kind, track)).map(([pid, r]) => ({ n: r.n, v: r.v, pid }));
      rows.sort((a, b) => (asc ? a.v - b.v : b.v - a.v));
      return rows.slice(0, n);
    },
    async rank(kind, track, pid, asc) {
      const m = map(kind, track), me = m[pid];
      if (!me) return 0;
      let better = 0;
      for (const r of Object.values(m)) if (asc ? r.v < me.v : r.v > me.v) better++;
      return better + 1;
    },
    async forget(pid) {
      let n = 0;
      for (const k of Object.keys(data)) if (data[k][pid]) { delete data[k][pid]; n++; }
      dirty = true;
      return n;
    },
    async purge(days) {
      const limit = Date.now() - days * 86400000;
      let n = 0;
      for (const k of Object.keys(data)) for (const pid of Object.keys(data[k])) if ((data[k][pid].ts || 0) < limit) { delete data[k][pid]; n++; }
      if (n) dirty = true;
      return n;
    },
    async close() { clearInterval(timer); },
  };
}

// ---------------------------------------------------------------- PostgreSQL (Neon) deposu
function createPgStore(connectionString) {
  const { Pool } = require('pg');
  const local = /(^|@)(localhost|127\.0\.0\.1)([:/]|$)/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: local ? false : { rejectUnauthorized: false },     // Neon SSL ister
    max: 5,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 15000,                          // Neon uykudan uyanirken beklenebilir
  });
  pool.on('error', (e) => console.warn('[pg] bosta baglanti hatasi:', e.message));   // surec dusmesin
  return {
    name: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS scores (
        kind text NOT NULL, track int NOT NULL DEFAULT 0, pid text NOT NULL, name text NOT NULL,
        v double precision NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (kind, track, pid))`);
      await pool.query('CREATE INDEX IF NOT EXISTS scores_board ON scores (kind, track, v)');
      await pool.query('CREATE INDEX IF NOT EXISTS scores_updated ON scores (updated_at)');
    },
    async getRow(kind, track, pid) {
      const r = await pool.query('SELECT v, extract(epoch from updated_at) * 1000 AS ts FROM scores WHERE kind=$1 AND track=$2 AND pid=$3', [kind, kind === 'gems' ? 0 : track, pid]);
      return r.rows[0] ? { v: Number(r.rows[0].v), ts: Number(r.rows[0].ts) } : null;
    },
    async updateBest(kind, track, pid, name, v, asc) {
      const fn = asc ? 'LEAST' : 'GREATEST';
      await pool.query(
        `INSERT INTO scores (kind, track, pid, name, v) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (kind, track, pid) DO UPDATE SET name = EXCLUDED.name, v = ${fn}(scores.v, EXCLUDED.v), updated_at = now()`,
        [kind, kind === 'gems' ? 0 : track, pid, name, v]);
    },
    async top(kind, track, asc, n) {
      const r = await pool.query(`SELECT name AS n, v, pid FROM scores WHERE kind=$1 AND track=$2 ORDER BY v ${asc ? 'ASC' : 'DESC'} LIMIT $3`,
        [kind, kind === 'gems' ? 0 : track, n]);
      return r.rows.map((x) => ({ n: x.n, v: Number(x.v), pid: x.pid }));
    },
    async rank(kind, track, pid, asc) {
      const t = kind === 'gems' ? 0 : track;
      const me = await pool.query('SELECT v FROM scores WHERE kind=$1 AND track=$2 AND pid=$3', [kind, t, pid]);
      if (!me.rows[0]) return 0;
      const r = await pool.query(`SELECT count(*)::int AS c FROM scores WHERE kind=$1 AND track=$2 AND v ${asc ? '<' : '>'} $3`, [kind, t, me.rows[0].v]);
      return r.rows[0].c + 1;
    },
    async forget(pid) { const r = await pool.query('DELETE FROM scores WHERE pid=$1', [pid]); return r.rowCount; },
    async purge(days) { const r = await pool.query('DELETE FROM scores WHERE updated_at < now() - make_interval(days => $1::int)', [days]); return r.rowCount; },
    async close() { await pool.end(); },
  };
}

// ---------------------------------------------------------------- secim + saklama suresi temizligi
async function createStore(nTracks) {
  let store;
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      store = createPgStore(url);
      await store.init();
      console.log('[store] PostgreSQL (Neon) baglandi. Saklama suresi: ' + RETENTION_DAYS + ' gun.');
    } catch (e) {
      console.warn('[store] PostgreSQL baglanamadi, bellek deposuna geciliyor: ' + e.message);
      store = null;
    }
  }
  if (!store) {
    store = createMemoryStore(nTracks);
    await store.init();
    console.log('[store] Bellek + dosya deposu (kalici degil). Kalici kayit icin DATABASE_URL gir.');
  }

  const runPurge = () => store.purge(RETENTION_DAYS).then((n) => { if (n) console.log('[store] ' + n + ' eski kayit silindi (' + RETENTION_DAYS + ' gun hareketsiz).'); })
    .catch((e) => console.warn('[store] temizlik hatasi: ' + e.message));
  runPurge();
  const t = setInterval(runPurge, 6 * 3600 * 1000);
  t.unref();
  store.retentionDays = RETENTION_DAYS;
  return store;
}

module.exports = { createStore, RETENTION_DAYS };
