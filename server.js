/**
 * IRON HALO VERIFY v4.0.1 — Live Camera Scanner
 *
 * Scanner architecture: CLIENT-SIDE decode via Dynamsoft + html5-qrcode
 * - html5-qrcode: live camera viewfinder, continuous PDF417 scan
 * - Dynamsoft BarcodeReader: auto-switch after 10s, deblurLevel=5
 * - Photo mode: still capture + client-side decode fallback
 * - Manual entry: smooth fallback from scanner toolbar
 *
 * Server handles: auth, scan storage, risk scoring, watchlist, dashboard
 * Server does NOT decode barcodes (zxing-wasm removed — never worked on Render)
 *
 * Stack: Node 18+, Express 4, SQLite (better-sqlite3), bcryptjs, multer, uuid
 * Brand: Matte black + Vanguard blue (#0056A0)
 * Live URL: vanguard-shield.onrender.com
 *
 * ═══════════════════════════════════════════════════════════════
 * DEMO CHECKLIST — Normandy Park & Gardens Field Test
 * ═══════════════════════════════════════════════════════════════
 *
 * BEFORE DEMO:
 *   [ ] Render health: GET /api/health → {"status":"ok","version":"4.0.0"}
 *   [ ] Login on iPhone Safari: admin / vanguard2026
 *
 * SCAN FLOW:
 *   [ ] Tap big scan button → live camera opens with viewfinder
 *   [ ] Point at barcode on back of TN license
 *   [ ] html5-qrcode scans first 10 seconds
 *   [ ] Auto-switches to Dynamsoft enhanced scanner
 *   [ ] Success: vibrate + green flash → fields auto-filled
 *   [ ] Fail: tap Manual in toolbar → enter from license
 *
 * Logins: admin/vanguard2026 | guard/guard123 | demo/demo
 * ═══════════════════════════════════════════════════════════════
 */

const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;


// ═══════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'shield.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL, role TEXT DEFAULT 'guard',
    display_name TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY, guard_id TEXT, guard_name TEXT,
    first_name TEXT, last_name TEXT, middle_name TEXT,
    dl_number TEXT, dob TEXT, expiration TEXT,
    address TEXT, city TEXT, state TEXT, postal_code TEXT, sex TEXT,
    risk_score INTEGER DEFAULT 0, risk_flags TEXT DEFAULT '[]',
    status TEXT DEFAULT 'cleared', notes TEXT,
    dl_photo TEXT, bol_photo TEXT, truck_photo TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    id TEXT PRIMARY KEY, dl_number TEXT, last_name TEXT,
    first_name TEXT, reason TEXT, added_by TEXT, active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS raw_decodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    raw TEXT, engine TEXT, length INTEGER,
    guard_id TEXT, guard_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function seedUsers() {
  const users = [
    { id: uuidv4(), username: 'admin', password: 'vanguard2026', role: 'admin', display_name: 'Admin' },
    { id: uuidv4(), username: 'guard', password: 'guard123', role: 'guard', display_name: 'Guard 1' },
    { id: uuidv4(), username: 'mjohnson', password: 'guard123', role: 'guard', display_name: 'M. Johnson' },
    { id: uuidv4(), username: 'demo', password: 'demo', role: 'guard', display_name: 'Demo Guard' },
  ];
  for (const u of users) {
    const hash = bcrypt.hashSync(u.password, 10);
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
    if (existing) {
      db.prepare('UPDATE users SET password = ?, role = ?, display_name = ? WHERE username = ?')
        .run(hash, u.role, u.display_name, u.username);
    } else {
      db.prepare('INSERT INTO users (id, username, password, role, display_name) VALUES (?, ?, ?, ?, ?)')
        .run(u.id, u.username, hash, u.role, u.display_name);
    }
  }
  console.log('  \u2713 Users seeded');
}
seedUsers();


// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Sessions (in-memory)
const sessions = new Map();

function auth(req, res, next) {
  let tk = req.headers['x-auth-token'];
  // Also accept Bearer token for compatibility
  if (!tk) {
    const ah = req.headers['authorization'];
    if (ah && ah.startsWith('Bearer ')) tk = ah.substring(7);
  }
  if (!tk || !sessions.has(tk)) return res.status(401).json({ error: 'Not authenticated' });
  req.user = sessions.get(tk);
  next();
}


// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

// --- Auth ---
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Credentials required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = uuidv4();
  sessions.set(token, { id: user.id, username: user.username, role: user.role, display_name: user.display_name });
  res.json({ token, role: user.role, display_name: user.display_name });
});

app.post('/api/logout', (req, res) => {
  const tk = req.headers['x-auth-token'];
  if (tk) sessions.delete(tk);
  res.json({ ok: true });
});

// --- Scans ---
app.post('/api/scans', auth, upload.fields([
  { name: 'dl_photo', maxCount: 1 }, { name: 'bol_photo', maxCount: 1 }, { name: 'truck_photo', maxCount: 1 },
]), (req, res) => {
  const d = req.body;
  const id = uuidv4();
  const dlP = req.files?.dl_photo?.[0]?.buffer.toString('base64') || d.dl_photo || null;
  const bolP = req.files?.bol_photo?.[0]?.buffer.toString('base64') || d.bol_photo || null;
  const trkP = req.files?.truck_photo?.[0]?.buffer.toString('base64') || d.truck_photo || null;
  const { score, flags } = calcRisk(d);
  db.prepare(`INSERT INTO scans (id,guard_id,guard_name,first_name,last_name,middle_name,
    dl_number,dob,expiration,address,city,state,postal_code,sex,
    risk_score,risk_flags,status,notes,dl_photo,bol_photo,truck_photo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,req.user.id,req.user.display_name,
      d.first_name||'',d.last_name||'',d.middle_name||'',
      d.dl_number||'',d.dob||'',d.expiration||'',
      d.address||'',d.city||'',d.state||'',d.postal_code||'',d.sex||'',
      score,JSON.stringify(flags),score>=70?'flagged':'cleared',
      d.notes||'',dlP,bolP,trkP);
  res.json({ id, risk_score: score, risk_flags: flags, status: score>=70?'flagged':'cleared' });
});

function calcRisk(d) {
  let score = 0; const flags = [];
  if (d.dl_number) {
    const hit = db.prepare('SELECT * FROM watchlist WHERE dl_number = ? AND active = 1').get(d.dl_number);
    if (hit) { score += 50; flags.push(`WATCHLIST: ${hit.reason||'Listed'}`); }
  }
  if (d.last_name) {
    const hit = db.prepare('SELECT * FROM watchlist WHERE LOWER(last_name) = LOWER(?) AND active = 1').get(d.last_name);
    if (hit) { score += 30; flags.push(`NAME MATCH: ${hit.reason||'Listed'}`); }
  }
  if (d.expiration) {
    const c = (d.expiration||'').replace(/\//g,'');
    if (c.length===8) {
      const exp = new Date(`${c.slice(4,8)}-${c.slice(0,2)}-${c.slice(2,4)}`);
      if (exp < new Date()) { score += 25; flags.push('EXPIRED LICENSE'); }
    }
  }
  if (d.state && d.state.toUpperCase() !== 'TN') { score += 10; flags.push(`OUT OF STATE: ${d.state}`); }
  const h = new Date().getHours();
  if (h >= 22 || h < 5) { score += 10; flags.push('LATE NIGHT'); }
  if (d.dl_number) {
    const dup = db.prepare("SELECT COUNT(*) as c FROM scans WHERE dl_number=? AND created_at>datetime('now','-24 hours')").get(d.dl_number);
    if (dup && dup.c > 0) { score += 20; flags.push(`REPEAT: ${dup.c}x/24h`); }
  }
  return { score: Math.min(score,100), flags };
}

app.get('/api/scans', auth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(db.prepare('SELECT id,guard_name,first_name,last_name,dl_number,risk_score,status,created_at FROM scans ORDER BY created_at DESC LIMIT ?').all(limit));
});

app.get('/api/scans/:id', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM scans WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

// --- Watchlist ---
app.get('/api/watchlist', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM watchlist WHERE active=1 ORDER BY created_at DESC').all());
});
app.post('/api/watchlist', auth, (req, res) => {
  const { dl_number, last_name, first_name, reason } = req.body;
  const id = uuidv4();
  db.prepare('INSERT INTO watchlist (id,dl_number,last_name,first_name,reason,added_by) VALUES (?,?,?,?,?,?)')
    .run(id, dl_number||'', last_name||'', first_name||'', reason||'', req.user.display_name);
  res.json({ id });
});
app.delete('/api/watchlist/:id', auth, (req, res) => {
  db.prepare('UPDATE watchlist SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// --- Dashboard ---
app.get('/api/dashboard', auth, (req, res) => {
  const today = db.prepare("SELECT COUNT(*) as c FROM scans WHERE created_at>datetime('now','-24 hours')").get();
  const flagged = db.prepare("SELECT COUNT(*) as c FROM scans WHERE status='flagged' AND created_at>datetime('now','-24 hours')").get();
  const total = db.prepare('SELECT COUNT(*) as c FROM scans').get();
  const wl = db.prepare('SELECT COUNT(*) as c FROM watchlist WHERE active=1').get();
  const recent = db.prepare('SELECT id,guard_name,first_name,last_name,dl_number,risk_score,status,created_at FROM scans ORDER BY created_at DESC LIMIT 10').all();
  res.json({ today:today.c, flagged:flagged.c, total:total.c, watchlist:wl.c, recent });
});

// --- Debug: raw barcode captures ---
app.post('/api/debug/raw-decode', auth, (req, res) => {
  const { raw, engine, length } = req.body;
  if (!raw) return res.status(400).json({ error: 'No raw data' });
  db.prepare('INSERT INTO raw_decodes (raw, engine, length, guard_id, guard_name) VALUES (?, ?, ?, ?, ?)')
    .run(raw, engine || '', length || raw.length, req.user.id, req.user.display_name);
  console.log(`  [RAW-DECODE] Captured ${raw.length} chars from ${engine} by ${req.user.display_name}`);
  res.json({ ok: true, stored: raw.length });
});

app.get('/api/debug/raw-decode', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM raw_decodes ORDER BY created_at DESC LIMIT 20').all();
  res.json(rows);
});

// --- Health ---
app.get('/api/health', (req, res) => {
  res.json({ status:'ok', version:'4.0.1', scanner:'client-side (Dynamsoft + html5-qrcode)', uptime:Math.round(process.uptime()) });
});


// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, async () => {
  console.log('\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551  IRON HALO VERIFY v4.0                   \u2551');
  console.log('\u2551  Client-Side Scanner (Dynamsoft + h5qr)   \u2551');
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n');
  console.log(`  \u25b8 Server: http://localhost:${PORT}`);
  console.log('  \u25b8 Scanner: Dynamsoft BarcodeReader + html5-qrcode (client-side)');
  console.log('  \u25b8 Logins: admin/vanguard2026 | guard/guard123 | demo/demo\n');

  // Startup self-test
  try {
    const resp = await fetch(`http://localhost:${PORT}/api/health`);
    const data = await resp.json();
    console.log(`  \u2713 Self-test passed: v${data.version} scanner=${data.scanner}`);
  } catch (err) {
    console.error(`  FATAL: routes not registered \u2014 ${err.message}`);
  }
});
