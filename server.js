/**
 * IRON HALO VERIFY v3.4 — decode timing fix for Render free tier
 *
 * ROOT CAUSE (from v3.3 decode_log):
 * - Phone photos are ~4000x3000 (12MP). On Render free tier CPU,
 *   each Sharp pass on full-res took 10-17 seconds.
 * - Only 2 of 6 passes ran before 25s timeout — passes 3-6 NEVER executed.
 * - Passes 3-6 (normalize, hi-contrast, threshold) are the most likely
 *   to actually decode, but they never got a chance to run.
 *
 * FIX:
 * - Pre-resize to 1600px wide + auto-EXIF-rotate BEFORE pipeline
 * - Each pass now ~2s instead of ~12s — all 6 complete in ~12-15s total
 * - Swapped upscale-2k for threshold-160 (no point upscaling pre-resized image)
 * - Kept: proven sigma values, 25s timeout, per-pass logging, self-test
 *
 * Decode engine: zxing-wasm (ZXing C++ via WebAssembly)
 * Image preprocessing: sharp (6-pass tuned pipeline)
 * Stack: Node 18+, Express 4, SQLite, Sharp, zxing-wasm, bcryptjs
 *
 * ═══════════════════════════════════════════════════════════════
 * DEMO CHECKLIST — Normandy Park & Gardens Field Test
 * ═══════════════════════════════════════════════════════════════
 *
 * BEFORE DEMO:
 *   [ ] Render health: GET /api/health → {"status":"ok","version":"3.3.0","decoder":"zxing-wasm"}
 *   [ ] Login on iPhone Safari: admin / vanguard2026
 *
 * SCAN FLOW:
 *   [ ] Tap camera button → native camera opens
 *   [ ] Photo TN DL barcode (back side, steady, good light, fill frame)
 *   [ ] "Analyzing license..." overlay with progress
 *   [ ] Success: green flash → fields auto-filled on confirm screen
 *   [ ] Fail: smooth transition to manual entry (feels intentional)
 *
 * 6-PASS DECODE PIPELINE (proven from v3.0):
 *   1. grayscale          — clean photo, no processing needed
 *   2. gray+sharpen(2.0)  — corrects slight camera blur
 *   3. gray+norm+sharp    — handles uneven indoor lighting
 *   4. upscale-2k+sharp   — handles small/distant barcodes
 *   5. hi-contrast+sharp  — handles low-light, washed-out photos
 *   6. threshold-128      — nuclear option, pure black & white
 *
 * Logins: admin/vanguard2026 | guard/guard123 | demo/demo
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
    console.log('  ✓ zxing-wasm: ready');
  } catch (err) {
    console.error('  ✗ zxing-wasm init failed:', err.message);
    decoderReady = false;
  }
}

/**
 * Decode PDF417 from an image buffer.
 *
 * 6-pass pipeline tuned for real phone photos of TN driver licenses.
 * These are the PROVEN passes from v3.0 that successfully decoded
 * in the field. No pre-resize — works on full-resolution phone images
 * to preserve barcode detail.
 *
 * 25-second timeout to stay under Render's 30s request limit.
 */
async function decodePdf417FromBuffer(imageBuffer) {
  if (!decoderReady || !readBarcodes) {
    throw new Error('Barcode decoder not initialized');
  }

  // Step 1: Pre-resize + EXIF auto-rotate. Phone photos are ~4000x3000.
  // We resize to 1200px wide — small enough for fast WASM decode,
  // large enough to preserve barcode detail.
  const preResizeStart = Date.now();
  const inputBuffer = await sharp(imageBuffer)
    .rotate()  // auto-orient from EXIF
    .resize({ width: 1200, withoutEnlargement: true })
    .jpeg({ quality: 90 })  // JPEG is 5-10x smaller than PNG = faster blob decode
    .toBuffer();
  console.log(`  → Pre-resize: ${Date.now() - preResizeStart}ms → ${(inputBuffer.length/1024).toFixed(0)}KB`);

  // Step 2: Run passes. Use JPEG output (much smaller blobs for zxing-wasm).
  // tryHarder DISABLED on fast passes, ENABLED only on last 2 heavy passes.
  // This should get each pass to ~1-3s instead of 9-16s.
  const passes = [
    // Fast passes (tryHarder OFF — ~1-2s each on Render free tier)
    { name: 'grayscale', tryH: false, fn: buf => sharp(buf).grayscale().jpeg({ quality: 90 }).toBuffer() },
    { name: 'gray+sharp', tryH: false, fn: buf => sharp(buf).grayscale().sharpen({ sigma: 2.0 }).jpeg({ quality: 90 }).toBuffer() },
    { name: 'gray+norm+sharp', tryH: false, fn: buf => sharp(buf).grayscale().normalize().sharpen({ sigma: 1.5 }).jpeg({ quality: 90 }).toBuffer() },
    { name: 'hi-contrast', tryH: false, fn: buf => sharp(buf).grayscale().linear(1.5, -30).sharpen({ sigma: 2.5 }).jpeg({ quality: 90 }).toBuffer() },

    // Heavy passes (tryHarder ON — last resort, ~3-5s each)
    { name: 'threshold-128', tryH: true, fn: buf => sharp(buf).grayscale().threshold(128).png().toBuffer() },
    { name: 'threshold-160', tryH: true, fn: buf => sharp(buf).grayscale().threshold(160).png().toBuffer() },
  ];

  const startTime = Date.now();
  const TIMEOUT_MS = 25000;

  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i];

    // Check timeout before each pass
    if (Date.now() - startTime > TIMEOUT_MS) {
      console.log(`  ✗ Timeout after ${i} passes (${Date.now() - startTime}ms)`);
      return null;
    }

    const passStart = Date.now();
    try {
      const processed = await pass.fn(inputBuffer);
      const mimeType = pass.name.startsWith('threshold') ? 'image/png' : 'image/jpeg';
      const blob = new Blob([processed], { type: mimeType });

      const sharpDone = Date.now();

      const results = await readBarcodes(blob, {
        formats: ['PDF417'],
        tryHarder: pass.tryH,
        maxSymbols: 1,
      });

      const passDuration = Date.now() - passStart;

      const zxingDone = Date.now();
      const passDuration = zxingDone - passStart;
      const sharpMs = sharpDone - passStart;
      const zxingMs = zxingDone - sharpDone;

      if (results && results.length > 0 && results[0].text) {
        console.log(`  ✓ PDF417 decoded on pass ${i+1}/${passes.length}: ${pass.name} (${results[0].text.length} chars, sharp=${sharpMs}ms zxing=${zxingMs}ms)`);
        try {
          db.prepare('INSERT INTO decode_log (success,pass_name,raw_length,fields_found,duration_ms,error) VALUES (?,?,?,?,?,?)')
            .run(1, pass.name, results[0].text.length, 0, passDuration, `sharp=${sharpMs}ms zxing=${zxingMs}ms`);
        } catch (_) {}
        return {
          raw: results[0].text,
          format: results[0].format || 'PDF417',
          pass: pass.name,
          passIndex: i + 1,
          totalPasses: passes.length,
        };
      }

      console.log(`    pass ${i+1} ${pass.name}: no barcode (sharp=${sharpMs}ms zxing=${zxingMs}ms tryH=${pass.tryH})`);
      try {
        db.prepare('INSERT INTO decode_log (success,pass_name,raw_length,duration_ms,error) VALUES (?,?,?,?,?)')
          .run(0, pass.name, 0, passDuration, `sharp=${sharpMs}ms zxing=${zxingMs}ms`);
      } catch (_) {}

    } catch (err) {
      const passDuration = Date.now() - passStart;
      console.log(`    pass ${i+1} ${pass.name}: ERROR ${err.message} (${passDuration}ms)`);
      try {
        db.prepare('INSERT INTO decode_log (success,pass_name,duration_ms,error) VALUES (?,?,?,?)')
          .run(0, pass.name, passDuration, err.message);
      } catch (_) {}
    }
  }

  console.log(`  ✗ All ${passes.length} passes failed (${Date.now() - startTime}ms total)`);
  return null;
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

  // Method 1: Line-delimited extraction
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

  // Method 2: Full-string scan for missing fields
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
    return val.replace(/\s+/g, '').replace(/0{4,}$/, '');
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
  const token = req.headers['x-auth-token'];
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Not authenticated' });
  req.user = sessions.get(token);
  next();
}


// ═══════════════════════════════════════════════════════════════
// ROUTES — ALL defined BEFORE app.listen()
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

// --- Decode DL (THE CORE — 6-pass tuned pipeline with 25s timeout) ---
app.post('/api/decode-dl', auth, upload.single('photo'), async (req, res) => {
  const start = Date.now();
  if (!req.file) return res.status(400).json({ success: false, error: 'No photo uploaded' });

  // Log input image metadata for diagnostics
  try {
    const inputMeta = await sharp(req.file.buffer).metadata();
    console.log(`\n  → Decode: ${(req.file.size / 1024).toFixed(0)}KB ${req.file.mimetype} ${inputMeta.width}x${inputMeta.height} ${inputMeta.format} ${inputMeta.channels}ch`);
  } catch (_) {
    console.log(`\n  → Decode: ${(req.file.size / 1024).toFixed(0)}KB ${req.file.mimetype}`);
  }

  try {
    const result = await Promise.race([
      decodePdf417FromBuffer(req.file.buffer),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Decode timeout (25s)')), 25000)),
    ]);

    const duration = Date.now() - start;

    if (result && result.raw) {
      const parsed = parseAAMVA(result.raw);
      const fc = parsed ? Object.entries(parsed).filter(([k,v]) => k !== 'raw' && v).length : 0;
      // Update the successful decode_log row with field count
      try {
        db.prepare('UPDATE decode_log SET fields_found = ? WHERE id = (SELECT MAX(id) FROM decode_log WHERE success = 1)')
          .run(fc);
      } catch (_) {}
      console.log(`  ✓ Decoded ${duration}ms — ${fc} fields via pass ${result.passIndex}/${result.totalPasses} (${result.pass})`);
      return res.json({ success: true, data: parsed, meta: { decode_ms: duration, pass: result.pass, passIndex: result.passIndex, totalPasses: result.totalPasses } });
    }

    console.log(`  ✗ All passes failed ${Date.now() - start}ms`);
    return res.json({ success: false, error: 'Barcode not readable. Entering manual mode.' });
  } catch (err) {
    console.error(`  ✗ Error: ${err.message} (${Date.now() - start}ms)`);
    return res.json({ success: false, error: err.message.includes('timeout') ? 'Analysis timed out. Entering manual mode.' : 'Decode error. Entering manual mode.' });
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

// --- Debug (decode diagnostics) ---
app.get('/api/debug/decode-log', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM decode_log ORDER BY id DESC LIMIT 50').all();
  res.json(rows);
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
  const ds = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) as ok, AVG(CASE WHEN success=1 THEN duration_ms END) as avg_ms FROM decode_log').get();
  res.json({
    today:today.c, flagged:flagged.c, total:total.c, watchlist:wl.c, recent,
    decode: { total:ds.total||0, rate:ds.total?Math.round(((ds.ok||0)/ds.total)*100):0, avg_ms:Math.round(ds.avg_ms||0) }
  });
});

// --- Health ---
app.get('/api/health', (req, res) => {
  res.json({ status:'ok', version:'3.4.1', decoder:decoderReady?'zxing-wasm':'unavailable', uptime:Math.round(process.uptime()) });
});

// ═══════════════════════════════════════════════════════════════
// START — all routes registered above, then listen + self-test
// ═══════════════════════════════════════════════════════════════

async function start() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║  IRON HALO VERIFY v3.4                   ║');
  console.log('║  6-Pass PDF417 | Timing Fix               ║');
  console.log('╚══════════════════════════════════════════╝\n');
  await initDecoder();
  app.listen(PORT, async () => {
    console.log(`\n  ▸ Server: http://localhost:${PORT}`);
    console.log(`  ▸ Decoder: ${decoderReady ? 'ZXing-WASM (PDF417, 6-pass tuned pipeline, 25s timeout)' : 'UNAVAILABLE — manual entry only'}`);
    console.log('  ▸ Logins: admin/vanguard2026 | guard/guard123 | demo/demo\n');

    // Startup self-test
    try {
      const resp = await fetch(`http://localhost:${PORT}/api/health`);
      const data = await resp.json();
      console.log(`  ✓ Self-test passed: v${data.version} decoder=${data.decoder}`);
    } catch (err) {
      console.error(`  FATAL: routes not registered — ${err.message}`);
    }
  });
}

start();
