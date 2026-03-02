/**
 * IRON HALO VERIFY v3.1 — Production Server
 * Server-side PDF417 decoding | AAMVA parsing | Photo capture
 *
 * Decode engine: zxing-wasm (ZXing C++ via WebAssembly)
 * Image preprocessing: sharp (7-pass pipeline)
 * Stack: Node 18+, Express 4, SQLite, Sharp, zxing-wasm, bcryptjs
 *
 * ═══════════════════════════════════════════════════════════════
 * DEMO CHECKLIST — Normandy Park & Gardens Field Test
 * ═══════════════════════════════════════════════════════════════
 *
 * BEFORE DEMO:
 *   [ ] Render health check: GET /api/health → {"status":"ok","version":"3.1.0","decoder":"zxing-wasm"}
 *   [ ] Login on iPhone Safari: admin / vanguard2026
 *   [ ] Login on Android Chrome: guard / guard123
 *   [ ] Confirm bottom nav shows: Scan | History | Dashboard
 *
 * SCAN FLOW (the money demo):
 *   [ ] Tap big camera button → iPhone native camera opens
 *   [ ] Photo of TN DL barcode (back side, steady, good light)
 *   [ ] "Reading barcode..." overlay appears
 *   [ ] Confirm screen shows: First Name, Last Name, DL#, DOB, Exp, Address
 *   [ ] Tap "CONFIRM & SAVE" → risk score result
 *   [ ] Green CLEARED (score < 30), Amber CAUTION (30-69), Red FLAGGED (70+)
 *
 * MANUAL ENTRY FALLBACK:
 *   [ ] From scan screen → "Manual Entry" button
 *   [ ] Enter name, DL#, DOB, state → Submit
 *   [ ] Risk score displays correctly
 *
 * RISK SCORING:
 *   [ ] Watchlist hit = +50
 *   [ ] Name match = +30
 *   [ ] Expired license = +25
 *   [ ] Repeat scan (24h) = +20
 *   [ ] Out of state = +10
 *   [ ] Late night (10pm-5am) = +10
 *
 * DASHBOARD:
 *   [ ] Stats show: Today, Flagged, All Time, Watchlist count
 *   [ ] Decode engine stats: success rate, avg ms
 *   [ ] Add to watchlist → shows in list
 *
 * IF BARCODE FAILS:
 *   → Try closer, better light, hold steady 2 sec
 *   → If still fails, use Manual Entry — the fallback always works
 *
 * Logins: admin/vanguard2026 | guard/guard123 | demo/demo
 * Live: vanguard-shield.onrender.com
 * ═══════════════════════════════════════════════════════════════
 */

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════
// BARCODE DECODER — Server-side PDF417 via zxing-wasm
// ═══════════════════════════════════════════════════════════════

let readBarcodes = null;
let decoderReady = false;

async function initDecoder() {
  try {
    const zxingReader = await import('zxing-wasm/reader');
    readBarcodes = zxingReader.readBarcodes;
    decoderReady = true;
    console.log('  ✓ ZXing-WASM PDF417 decoder initialized');
  } catch (err) {
    console.error('  ✗ Decoder init failed:', err.message);
    decoderReady = false;
  }
}

/**
 * Decode PDF417 from an image buffer.
 * 7-pass preprocessing pipeline for robustness against
 * blurry, off-angle, indoor-lighting phone photos.
 */
async function decodePdf417FromBuffer(imageBuffer) {
  if (!decoderReady || !readBarcodes) {
    throw new Error('Barcode decoder not initialized');
  }

  const passes = [
    { name: 'grayscale', fn: buf => sharp(buf).grayscale().png().toBuffer() },
    { name: 'gray+sharp', fn: buf => sharp(buf).grayscale().sharpen({ sigma: 2.0 }).png().toBuffer() },
    { name: 'normalize', fn: buf => sharp(buf).grayscale().normalize().sharpen({ sigma: 1.5 }).png().toBuffer() },
    { name: 'upscale-2k', fn: buf => sharp(buf).resize({ width: 2000, withoutEnlargement: false }).grayscale().sharpen({ sigma: 2.0 }).png().toBuffer() },
    { name: 'resize-1200', fn: buf => sharp(buf).resize({ width: 1200 }).grayscale().normalize().sharpen({ sigma: 1.5 }).png().toBuffer() },
    { name: 'hi-contrast', fn: buf => sharp(buf).grayscale().linear(1.5, -30).sharpen({ sigma: 2.5 }).png().toBuffer() },
    { name: 'threshold', fn: buf => sharp(buf).grayscale().threshold(128).png().toBuffer() },
  ];

  for (const pass of passes) {
    try {
      const processed = await pass.fn(imageBuffer);
      const blob = new Blob([processed], { type: 'image/png' });

      const results = await readBarcodes(blob, {
        formats: ['PDF417'],
        tryHarder: true,
        maxSymbols: 1,
      });

      if (results && results.length > 0 && results[0].text) {
        console.log(`  ✓ PDF417 decoded on pass: ${pass.name} (${results[0].text.length} chars)`);
        return {
          raw: results[0].text,
          format: results[0].format || 'PDF417',
          pass: pass.name,
        };
      }
    } catch (_) {
      // Continue to next pass silently
    }
  }

  return null; // All passes exhausted
}


// ═══════════════════════════════════════════════════════════════
// AAMVA PARSER — Driver license fields from raw PDF417 barcode
// ═══════════════════════════════════════════════════════════════

function parseAAMVA(raw) {
  if (!raw || typeof raw !== 'string') return null;

  const fieldMap = {
    'DCS': 'last_name',
    'DAB': 'last_name',
    'DCT': 'first_name',
    'DAC': 'first_name',
    'DAD': 'middle_name',
    'DAG': 'address',
    'DAI': 'city',
    'DAJ': 'state',
    'DAK': 'postal_code',
    'DBB': 'dob',
    'DBA': 'expiration',
    'DAQ': 'dl_number',
    'DAY': 'eye_color',
    'DAU': 'height',
    'DBC': 'sex',
    'DBD': 'issue_date',
  };

  const fields = {};

  // Method 1: Line-delimited extraction (handles most AAMVA formats)
  const lines = raw.split(/[\r\n]+/);
  for (const line of lines) {
    const allMatches = [...line.matchAll(/(D[A-Z]{2})([^D]*?)(?=D[A-Z]{2}|$)/g)];
    if (allMatches.length > 0) {
      for (const m of allMatches) {
        const code = m[1], value = m[2].trim();
        if (fieldMap[code] && value && !fields[fieldMap[code]]) {
          fields[fieldMap[code]] = value;
        }
      }
    } else {
      const match = line.match(/(D[A-Z]{2})(.*)/);
      if (match) {
        const code = match[1], value = match[2].trim();
        if (fieldMap[code] && value && !fields[fieldMap[code]]) {
          fields[fieldMap[code]] = value;
        }
      }
    }
  }

  // Method 2: Full-string scan for any fields still missing
  for (const [code, fieldName] of Object.entries(fieldMap)) {
    if (fields[fieldName]) continue;
    const regex = new RegExp(code + '([^\\n\\r\\x1e\\x0a\\x0d]{1,100}?)(?=D[A-Z]{2}|[\\n\\r\\x1e]|$)', 'g');
    const m = regex.exec(raw);
    if (m && m[1]) {
      fields[fieldName] = m[1].trim();
    }
  }

  function fmtDate(val) {
    if (!val) return '';
    const d = val.replace(/[^0-9]/g, '');
    if (d.length === 8) return `${d.slice(0,2)}/${d.slice(2,4)}/${d.slice(4,8)}`;
    return val;
  }

  function fmtPostal(val) {
    if (!val) return '';
    const c = val.replace(/\s+/g, '').replace(/0{4,}$/, '');
    return c;
  }

  function fmtSex(val) {
    if (val === '1') return 'M';
    if (val === '2') return 'F';
    return val || '';
  }

  return {
    first_name: fields.first_name || '',
    last_name: fields.last_name || '',
    middle_name: fields.middle_name || '',
    address: fields.address || '',
    city: fields.city || '',
    state: fields.state || '',
    postal_code: fmtPostal(fields.postal_code),
    dob: fmtDate(fields.dob),
    dl_number: fields.dl_number || '',
    expiration: fmtDate(fields.expiration),
    sex: fmtSex(fields.sex),
    raw: raw,
  };
}


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
  CREATE TABLE IF NOT EXISTS decode_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    success INTEGER, pass_name TEXT, raw_length INTEGER,
    fields_found INTEGER, error TEXT, duration_ms INTEGER,
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
  console.log('  ✓ Users seeded');
}
seedUsers();


// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Sessions (in-memory)
const sessions = new Map();

function auth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Not authenticated' });
  req.user = sessions.get(token);
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
  const token = req.headers['x-auth-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// --- Decode DL (THE CORE) ---
app.post('/api/decode-dl', auth, upload.single('photo'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ success: false, error: 'No photo uploaded' });

  console.log(`\n  → Decode: ${(req.file.size / 1024).toFixed(0)}KB ${req.file.mimetype}`);

  try {
    const result = await decodePdf417FromBuffer(req.file.buffer);
    const duration = Date.now() - start;

    if (result && result.raw) {
      const parsed = parseAAMVA(result.raw);
      const fc = parsed ? Object.entries(parsed).filter(([k,v]) => k !== 'raw' && v).length : 0;
      db.prepare('INSERT INTO decode_log (success,pass_name,raw_length,fields_found,duration_ms) VALUES (?,?,?,?,?)')
        .run(1, result.pass, result.raw.length, fc, duration);
      console.log(`  ✓ Decoded ${duration}ms — ${fc} fields`);
      return res.json({ success: true, data: parsed, meta: { decode_ms: duration, pass: result.pass } });
    }

    db.prepare('INSERT INTO decode_log (success,error,duration_ms) VALUES (?,?,?)')
      .run(0, 'All passes failed', Date.now() - start);
    console.log(`  ✗ Failed ${Date.now() - start}ms`);
    return res.json({ success: false, error: 'Unable to decode PDF417 from image. Hold phone closer, ensure good lighting, keep steady.' });
  } catch (err) {
    db.prepare('INSERT INTO decode_log (success,error,duration_ms) VALUES (?,?,?)')
      .run(0, err.message, Date.now() - start);
    console.error(`  ✗ Error: ${err.message}`);
    return res.json({ success: false, error: 'Decode error. Please try again or enter details manually.' });
  }
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
  const ds = db.prepare('SELECT COUNT(*) as total, SUM(success) as ok, AVG(duration_ms) as avg_ms FROM decode_log').get();
  res.json({
    today:today.c, flagged:flagged.c, total:total.c, watchlist:wl.c, recent,
    decode: { total:ds.total||0, rate:ds.total?Math.round((ds.ok/ds.total)*100):0, avg_ms:Math.round(ds.avg_ms||0) }
  });
});

// --- Health ---
app.get('/api/health', (req, res) => {
  res.json({ status:'ok', version:'3.1.0', decoder:decoderReady?'zxing-wasm':'unavailable', uptime:Math.round(process.uptime()) });
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

async function start() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  IRON HALO VERIFY v3.1                   ║');
  console.log('║  Server-Side PDF417 | Production Build    ║');
  console.log('╚══════════════════════════════════════════╝\n');
  await initDecoder();
  app.listen(PORT, () => {
    console.log(`\n  ▸ Server: http://localhost:${PORT}`);
    console.log(`  ▸ Decoder: ${decoderReady ? 'ZXing-WASM (PDF417 only, 7-pass pipeline)' : 'UNAVAILABLE'}`);
    console.log('  ▸ Logins: admin/vanguard2026 | guard/guard123 | demo/demo\n');
  });
}

start();
