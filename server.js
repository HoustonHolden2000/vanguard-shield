/**
 * IRON HALO VERIFY v5.1 — Photo-Only Scanner
 *
 * Scanner architecture:
 * - CLIENT-SIDE: Photo capture → Dynamsoft BarcodeReader v9.6.42 (self-hosted /dbr/)
 * - No live viewfinder — photo-only for maximum reliability
 * - Manual entry fallback always available
 *
 * Server handles: auth, scan storage, risk scoring, watchlist, dashboard
 *
 * Stack: Node 18+, Express 4, SQLite, bcryptjs, multer, uuid
 * Brand: Matte black + Vanguard blue (#0056A0)
 * Live URL: vanguard-shield.onrender.com
 *
 * Logins: admin/vanguard2026 | guard/guard123 | demo/demo
 */

const express = require('express');
const compression = require('compression');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const ZXing = require('@zxing/library');

const app = express();
const PORT = process.env.PORT || 3000;

// Gzip compression — critical for 3MB WASM file → ~1MB transfer
app.use(compression());


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
  CREATE TABLE IF NOT EXISTS decode_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_size INTEGER, success INTEGER, result TEXT,
    elapsed INTEGER, error TEXT,
    guard_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS client_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    step TEXT, error TEXT, details TEXT,
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
  if (!tk) {
    const ah = req.headers['authorization'];
    if (ah && ah.startsWith('Bearer ')) tk = ah.substring(7);
  }
  if (!tk || !sessions.has(tk)) return res.status(401).json({ error: 'Not authenticated' });
  req.user = sessions.get(tk);
  next();
}


// ═══════════════════════════════════════════════════════════════
// BARCODE DECODE ENGINE (server-side)
// ═══════════════════════════════════════════════════════════════

async function decodeBarcode(imageBuffer) {
  const {
    MultiFormatReader, BarcodeFormat, DecodeHintType,
    RGBLuminanceSource, BinaryBitmap, HybridBinarizer
  } = ZXing;

  // 7 decode attempts with different preprocessing
  const attempts = [
    { label: '1600px plain',          resize: 1600, sharpen: false, normalize: false, tryHarder: true },
    { label: '1600px sharp+norm',     resize: 1600, sharpen: true,  normalize: true,  tryHarder: true },
    { label: '2400px sharp',          resize: 2400, sharpen: true,  normalize: false, tryHarder: true },
    { label: '1200px sharp+norm',     resize: 1200, sharpen: true,  normalize: true,  tryHarder: true },
    { label: '800px sharp+norm',      resize: 800,  sharpen: true,  normalize: true,  tryHarder: true },
    { label: '3200px plain',          resize: 3200, sharpen: false, normalize: false, tryHarder: true },
    { label: '1600px threshold',      resize: 1600, sharpen: true,  normalize: true,  tryHarder: true, threshold: true },
  ];

  for (const attempt of attempts) {
    try {
      // Output RGBA (4 channels) — what RGBLuminanceSource expects
      let pipeline = sharp(imageBuffer)
        .rotate()
        .resize(attempt.resize, null, { withoutEnlargement: true });
      if (attempt.sharpen) pipeline = pipeline.sharpen({ sigma: 1.5 });
      if (attempt.normalize) pipeline = pipeline.normalize();
      if (attempt.threshold) pipeline = pipeline.threshold(128);
      pipeline = pipeline.ensureAlpha().raw();

      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      console.log(`  [DECODE] Try "${attempt.label}": ${info.width}x${info.height} ch=${info.channels} data=${data.length}`);

      const reader = new MultiFormatReader();
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      reader.setHints(hints);

      // RGBLuminanceSource expects RGBA data (4 bytes per pixel)
      const luminanceSource = new RGBLuminanceSource(
        new Uint8ClampedArray(data), info.width, info.height
      );
      const bitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
      const result = reader.decode(bitmap);

      if (result && result.getText()) {
        console.log(`  [DECODE] SUCCESS on: "${attempt.label}"`);
        return result.getText();
      }
    } catch (e) {
      console.log(`  [DECODE] "${attempt.label}" failed: ${e.message || 'no barcode'}`);
    }
  }

  return null;
}

function parseAAMVA(raw) {
  const fields = {};
  const map = {
    'DCS': 'last_name', 'DAB': 'last_name', 'DAC': 'first_name', 'DCT': 'first_name',
    'DAD': 'middle_name', 'DBB': 'dob', 'DBA': 'expiration',
    'DAQ': 'dl_number', 'DAG': 'address', 'DAI': 'city',
    'DAJ': 'state', 'DAK': 'postal_code', 'DBC': 'sex',
  };

  // Method 1: Split by delimiters
  const lines = raw.split(/[\n\r\x1e\x1d]+/);
  for (const line of lines) {
    const trimmed = line.trim();
    for (const [code, field] of Object.entries(map)) {
      if (trimmed.startsWith(code)) {
        let val = trimmed.substring(code.length).trim();
        if (field === 'first_name' && fields.first_name && code === 'DCT') continue;
        if (val) fields[field] = val;
      }
    }
  }

  // Method 2: Regex fallback
  for (const [code, field] of Object.entries(map)) {
    if (fields[field]) continue;
    const re = new RegExp(code + '([^\\n\\r\\x1e\\x1d]{1,120}?)(?=D[A-Z]{2}|[\\n\\r\\x1e\\x1d]|$)');
    const m = re.exec(raw);
    if (m && m[1] && m[1].trim()) fields[field] = m[1].trim();
  }

  // Method 3: Aggressive matchAll
  if (Object.keys(fields).length < 3) {
    const allMatches = [...raw.matchAll(/(D[A-Z]{2})([\s\S]*?)(?=D[A-Z]{2}|$)/g)];
    for (const m of allMatches) {
      const code = m[1], val = m[2].trim();
      if (map[code] && val && !fields[map[code]]) fields[map[code]] = val;
    }
  }

  // Format dates
  for (const df of ['dob', 'expiration']) {
    if (fields[df] && fields[df].length >= 8) {
      const d = fields[df].replace(/[^0-9]/g, '');
      if (d.length === 8) {
        const f2 = parseInt(d.slice(0, 2));
        if (f2 > 12) fields[df] = d.slice(4, 6) + '/' + d.slice(6, 8) + '/' + d.slice(0, 4);
        else fields[df] = d.slice(0, 2) + '/' + d.slice(2, 4) + '/' + d.slice(4, 8);
      }
    }
  }

  if (fields.sex === '1') fields.sex = 'M';
  else if (fields.sex === '2') fields.sex = 'F';
  if (fields.postal_code) fields.postal_code = fields.postal_code.replace(/\s+/g, '').substring(0, 5);

  for (const nf of ['first_name', 'last_name', 'middle_name', 'city']) {
    if (fields[nf]) fields[nf] = fields[nf].charAt(0).toUpperCase() + fields[nf].slice(1).toLowerCase();
  }

  return fields;
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

// --- Barcode Decode (server-side) ---
app.post('/api/barcode/decode', auth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No photo provided' });

  const photoKB = (req.file.size/1024).toFixed(0);
  console.log(`  [DECODE] Photo received: ${photoKB}KB from ${req.user.display_name}`);
  const startTime = Date.now();

  try {
    const raw = await decodeBarcode(req.file.buffer);
    const elapsed = Date.now() - startTime;

    if (raw) {
      console.log(`  [DECODE] SUCCESS in ${elapsed}ms, raw length: ${raw.length}`);
      db.prepare('INSERT INTO raw_decodes (raw, engine, length, guard_id, guard_name) VALUES (?, ?, ?, ?, ?)')
        .run(raw, 'server-zxing', raw.length, req.user.id, req.user.display_name);
      db.prepare('INSERT INTO decode_attempts (photo_size,success,result,elapsed,guard_name) VALUES (?,1,?,?,?)')
        .run(req.file.size, 'decoded ' + raw.length + ' chars', elapsed, req.user.display_name);
      const fields = parseAAMVA(raw);
      res.json({ success: true, raw, fields, elapsed });
    } else {
      console.log(`  [DECODE] FAILED after ${elapsed}ms — no barcode found`);
      db.prepare('INSERT INTO decode_attempts (photo_size,success,result,elapsed,guard_name) VALUES (?,0,?,?,?)')
        .run(req.file.size, 'no barcode found', elapsed, req.user.display_name);
      res.json({ success: false, error: 'Could not decode barcode from photo', elapsed });
    }
  } catch (e) {
    const elapsed = Date.now() - startTime;
    console.error(`  [DECODE] ERROR: ${e.message}`);
    db.prepare('INSERT INTO decode_attempts (photo_size,success,error,elapsed,guard_name) VALUES (?,0,?,?,?)')
      .run(req.file.size, e.message, elapsed, req.user.display_name);
    res.json({ success: false, error: e.message });
  }
});

// --- Client error reporting ---
app.post('/api/client-error', express.json(), (req, res) => {
  const { step, error, details } = req.body;
  db.prepare('INSERT INTO client_errors (step, error, details) VALUES (?, ?, ?)')
    .run(step || '', error || '', details || '');
  res.json({ ok: true });
});

app.get('/api/debug/decode-attempts', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM decode_attempts ORDER BY created_at DESC LIMIT 20').all());
});

app.get('/api/debug/client-errors', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM client_errors ORDER BY created_at DESC LIMIT 20').all());
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

// --- Debug ---
app.post('/api/debug/raw-decode', auth, (req, res) => {
  const { raw, engine, length } = req.body;
  if (!raw) return res.status(400).json({ error: 'No raw data' });
  db.prepare('INSERT INTO raw_decodes (raw, engine, length, guard_id, guard_name) VALUES (?, ?, ?, ?, ?)')
    .run(raw, engine || '', length || raw.length, req.user.id, req.user.display_name);
  res.json({ ok: true, stored: raw.length });
});

app.get('/api/debug/raw-decode', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM raw_decodes ORDER BY created_at DESC LIMIT 20').all());
});

// --- Health ---
app.get('/api/health', (req, res) => {
  res.json({ status:'ok', version:'6.2.0', scanner:'Dynamsoft BarcodeReader v9.6.42 (photo-only)', uptime:Math.round(process.uptime()) });
});


// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, async () => {
  console.log('\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('\u2551  IRON HALO VERIFY v4.1                   \u2551');
  console.log('\u2551  Hybrid: Dynamsoft + Server @zxing        \u2551');
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n');
  console.log(`  \u25b8 Server: http://localhost:${PORT}`);
  console.log('  \u25b8 Live scan: Dynamsoft BarcodeReader + html5-qrcode (client-side)');
  console.log('  \u25b8 Photo decode: @zxing/library + sharp (server-side)');
  console.log('  \u25b8 Logins: admin/vanguard2026 | guard/guard123 | demo/demo\n');

  try {
    const resp = await fetch(`http://localhost:${PORT}/api/health`);
    const data = await resp.json();
    console.log(`  \u2713 Self-test passed: v${data.version} scanner=${data.scanner}`);
  } catch (err) {
    console.error(`  FATAL: routes not registered \u2014 ${err.message}`);
  }
});
