const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'vanguard-shield-dev-secret-change-me';
const DB_PATH = process.env.DB_PATH || './data/shield.db';
const PHOTO_DIR = process.env.PHOTO_DIR || './data/photos';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(PHOTO_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════
// DATABASE INIT
// ═══════════════════════════════════════════════════════════
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'guard',
    full_name TEXT NOT NULL,
    site_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  );
  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT,
    city TEXT,
    state TEXT DEFAULT 'TN',
    client_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    guard_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    scan_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    dl_number TEXT, dl_state TEXT,
    first_name TEXT, last_name TEXT, middle_name TEXT,
    date_of_birth TEXT, expiration_date TEXT,
    address_street TEXT, address_city TEXT, address_state TEXT, address_zip TEXT,
    gender TEXT, eye_color TEXT, height TEXT, weight TEXT,
    carrier_name TEXT, carrier_mc_number TEXT, carrier_dot_number TEXT,
    truck_plate TEXT, trailer_number TEXT, bol_number TEXT,
    bol_photo_path TEXT, dl_photo_path TEXT, truck_photo_path TEXT,
    risk_score INTEGER DEFAULT 0, risk_flags TEXT, alert_level TEXT DEFAULT 'GREEN',
    latitude REAL, longitude REAL, integrity_hash TEXT, notes TEXT,
    FOREIGN KEY (guard_id) REFERENCES users(id),
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    id TEXT PRIMARY KEY,
    dl_number TEXT NOT NULL, dl_state TEXT,
    first_name TEXT, last_name TEXT,
    reason TEXT NOT NULL, severity TEXT DEFAULT 'YELLOW',
    added_by TEXT, added_at DATETIME DEFAULT CURRENT_TIMESTAMP, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS carriers (
    mc_number TEXT PRIMARY KEY, dot_number TEXT, legal_name TEXT,
    dba_name TEXT, status TEXT, last_checked DATETIME, data_json TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id TEXT, action TEXT NOT NULL, detail TEXT, ip_address TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_scans_dl ON scans(dl_number);
  CREATE INDEX IF NOT EXISTS idx_scans_site ON scans(site_id);
  CREATE INDEX IF NOT EXISTS idx_scans_guard ON scans(guard_id);
  CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(scan_timestamp);
  CREATE INDEX IF NOT EXISTS idx_watchlist_dl ON watchlist(dl_number);
`);

// ═══════════════════════════════════════════════════════════
// FORCE-REFRESH ADMIN CREDENTIALS ON EVERY STARTUP
// Prevents bcrypt/bcryptjs hash incompatibility issues
// ═══════════════════════════════════════════════════════════
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'vanguard2026';
const GUARD_USER = 'mjohnson';
const GUARD_PASS = 'guard123';

const existingAdmin = db.prepare("SELECT id, site_id FROM users WHERE username = ?").get(ADMIN_USER);
if (existingAdmin) {
  const freshHash = bcrypt.hashSync(ADMIN_PASS, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(freshHash, ADMIN_USER);
  console.log('[INIT] Refreshed admin credentials');
  
  const existingGuard = db.prepare("SELECT id FROM users WHERE username = ?").get(GUARD_USER);
  if (existingGuard) {
    const guardHash = bcrypt.hashSync(GUARD_PASS, 10);
    db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(guardHash, GUARD_USER);
    console.log('[INIT] Refreshed guard credentials');
  }
} else {
  const adminId = uuidv4();
  const siteId = uuidv4();
  const guardId = uuidv4();
  const adminHash = bcrypt.hashSync(ADMIN_PASS, 10);
  const guardHash = bcrypt.hashSync(GUARD_PASS, 10);
  
  db.prepare("INSERT INTO sites (id, name, address, city, state, client_name) VALUES (?, ?, ?, ?, ?, ?)")
    .run(siteId, 'Memphis Distribution Hub', '3500 Tchulahoma Rd', 'Memphis', 'TN', 'Barrett Distribution');
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, site_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(adminId, ADMIN_USER, adminHash, 'admin', 'Brad Thompson', siteId);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, site_id) VALUES (?, ?, ?, ?, ?, ?)")
    .run(guardId, GUARD_USER, guardHash, 'guard', 'Marcus Johnson', siteId);
  
  console.log('[INIT] Seeded admin (admin/vanguard2026) and guard (mjohnson/guard123)');
  console.log('[INIT] Seeded site: Memphis Distribution Hub');
}

// ═══════════════════════════════════════════════════════════
// AAMVA PDF417 PARSER (server-side)
// ═══════════════════════════════════════════════════════════
function parsePDF417(raw) {
  const fields = {};
  const map = {
    'DCS': 'last_name', 'DAC': 'first_name', 'DCT': 'first_name',
    'DAD': 'middle_name', 'DBB': 'date_of_birth', 'DBA': 'expiration_date',
    'DAQ': 'dl_number', 'DAG': 'address_street', 'DAI': 'address_city',
    'DAJ': 'address_state', 'DAK': 'address_zip', 'DBC': 'gender',
    'DAY': 'eye_color', 'DAU': 'height', 'DAW': 'weight', 'DCG': 'dl_country',
    'DCF': 'document_discriminator', 'DCA': 'dl_class', 'DCD': 'endorsements',
    'DBD': 'issue_date',
  };
  const lines = raw.split(/[\n\r\x1e\x1d]+/);
  for (const line of lines) {
    const trimmed = line.trim();
    for (const [code, field] of Object.entries(map)) {
      if (trimmed.startsWith(code)) {
        let val = trimmed.substring(code.length).trim();
        if (field === 'first_name' && fields.first_name && trimmed.startsWith('DCT')) continue;
        fields[field] = val;
      }
    }
  }
  const ansiMatch = raw.match(/\bDL(\w{2})/);
  if (ansiMatch && !fields.address_state) fields.dl_state = ansiMatch[1];
  if (fields.address_state) fields.dl_state = fields.address_state;
  
  for (const df of ['date_of_birth', 'expiration_date', 'issue_date']) {
    if (fields[df] && fields[df].length >= 8) {
      const d = fields[df].replace(/[^0-9]/g, '');
      if (d.length === 8) {
        const first2 = parseInt(d.slice(0, 2));
        if (first2 > 12) fields[df] = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
        else fields[df] = `${d.slice(4,8)}-${d.slice(0,2)}-${d.slice(2,4)}`;
      }
    }
  }
  if (fields.gender === '1') fields.gender = 'M';
  else if (fields.gender === '2') fields.gender = 'F';
  if (fields.address_zip) fields.address_zip = fields.address_zip.substring(0, 5);
  for (const nf of ['first_name', 'last_name', 'middle_name', 'address_city']) {
    if (fields[nf]) fields[nf] = fields[nf].charAt(0).toUpperCase() + fields[nf].slice(1).toLowerCase();
  }
  return fields;
}

// ═══════════════════════════════════════════════════════════
// RISK SCORING ENGINE
// ═══════════════════════════════════════════════════════════
function calculateRiskScore(scanData) {
  let score = 0;
  const flags = [];

  if (scanData.expiration_date) {
    const parts = scanData.expiration_date.split('-');
    if (parts.length === 3) {
      const exp = new Date(parts[0], parts[1] - 1, parts[2]);
      if (exp < new Date()) { score += 40; flags.push('EXPIRED_LICENSE'); }
    }
  }
  if (scanData.dl_number) {
    const watchHit = db.prepare("SELECT reason, severity FROM watchlist WHERE dl_number = ? AND active = 1").get(scanData.dl_number);
    if (watchHit) { score += watchHit.severity === 'RED' ? 50 : 30; flags.push(`WATCHLIST_HIT: ${watchHit.reason}`); }
  }
  if (scanData.dl_number) {
    const multiSite = db.prepare("SELECT COUNT(DISTINCT site_id) as cnt FROM scans WHERE dl_number = ? AND scan_timestamp > datetime('now', '-7 days')").get(scanData.dl_number);
    if (multiSite && multiSite.cnt >= 3) { score += 20; flags.push(`MULTI_SITE: ${multiSite.cnt} sites in 7 days`); }
  }
  if (scanData.dl_number && scanData.site_id) {
    const freq = db.prepare("SELECT COUNT(*) as cnt FROM scans WHERE dl_number = ? AND site_id = ? AND scan_timestamp > datetime('now', '-1 day')").get(scanData.dl_number, scanData.site_id);
    if (freq && freq.cnt >= 3) { score += 15; flags.push(`HIGH_FREQUENCY: ${freq.cnt}x in 24h at this site`); }
  }
  if (scanData.dl_state && scanData.dl_state !== 'TN') {
    const prior = db.prepare("SELECT COUNT(*) as cnt FROM scans WHERE dl_number = ?").get(scanData.dl_number);
    if (!prior || prior.cnt === 0) { score += 10; flags.push(`FIRST_SCAN_OUT_OF_STATE: ${scanData.dl_state}`); }
  }
  const hour = new Date().getHours();
  if (hour >= 22 || hour < 5) { score += 5; flags.push('OFF_HOURS_SCAN'); }
  if (scanData.bol_number && !scanData.carrier_mc_number && !scanData.carrier_dot_number) { score += 10; flags.push('BOL_NO_CARRIER_ID'); }
  if (!scanData.dl_number) { score += 25; flags.push('NO_DL_NUMBER'); }

  let alertLevel = 'GREEN';
  if (score >= 50) alertLevel = 'RED';
  else if (score >= 20) alertLevel = 'YELLOW';

  return { score: Math.min(score, 100), flags, alertLevel };
}

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════
const app = express();

// Relaxed CSP - allow CDN scripts for barcode scanning library
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://cdnjs.cloudflare.com", "blob:"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
    }
  }
}));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const month = new Date().toISOString().slice(0, 7);
    const dir = path.join(PHOTO_DIR, month);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

function audit(userId, action, detail, ip) {
  db.prepare("INSERT INTO audit_log (user_id, action, detail, ip_address) VALUES (?, ?, ?, ?)").run(userId, action, detail, ip);
}

// ═══════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  
  db.prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
  const site = user.site_id ? db.prepare("SELECT * FROM sites WHERE id = ?").get(user.site_id) : null;
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role, full_name: user.full_name, site_id: user.site_id }, JWT_SECRET, { expiresIn: '24h' });
  audit(user.id, 'LOGIN', `User ${username} logged in`, req.ip);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name, site_id: user.site_id, site_name: site ? site.name : 'Unassigned' } });
});

app.post('/api/auth/verify', authenticateToken, (req, res) => {
  const site = req.user.site_id ? db.prepare("SELECT name FROM sites WHERE id = ?").get(req.user.site_id) : null;
  res.json({ user: { ...req.user, site_name: site ? site.name : 'Unassigned' } });
});

// ═══════════════════════════════════════════════════════════
// BARCODE DECODE ENDPOINT (server-side fallback)
// ═══════════════════════════════════════════════════════════
app.post('/api/decode-dl', authenticateToken, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ success: false, error: 'No image provided' });
    
    // Decode base64 to buffer
    const imgBuffer = Buffer.from(image, 'base64');
    
    // Preprocess with sharp: resize, grayscale, sharpen for better barcode detection
    const processed = await sharp(imgBuffer)
      .resize(1600, null, { withoutEnlargement: true })
      .grayscale()
      .sharpen({ sigma: 1.5 })
      .normalize()
      .jpeg({ quality: 95 })
      .toBuffer();
    
    // Save preprocessed image temporarily for potential future processing
    const tempPath = path.join(PHOTO_DIR, `decode_${Date.now()}.jpg`);
    fs.writeFileSync(tempPath, processed);
    
    // Server-side decode not yet implemented with a barcode library
    // Return helpful error so client falls back to manual entry
    // TODO: Add zxing-wasm or zbar-wasm when npm package compatibility is confirmed
    fs.unlinkSync(tempPath);
    
    res.json({ 
      success: false, 
      error: 'Server-side barcode decoding coming soon. Use photo mode or manual entry.',
      preprocessed: true 
    });
    
  } catch (err) {
    console.error('[DECODE ERROR]', err);
    res.json({ success: false, error: 'Image processing failed' });
  }
});

// ═══════════════════════════════════════════════════════════
// SCAN ROUTES
// ═══════════════════════════════════════════════════════════
const scanUpload = upload.fields([
  { name: 'dl_photo', maxCount: 1 },
  { name: 'bol_photo', maxCount: 1 },
  { name: 'truck_photo', maxCount: 1 }
]);

app.post('/api/scans', authenticateToken, scanUpload, async (req, res) => {
  try {
    const scanId = uuidv4();
    const data = req.body;
    let dlPhotoPath = null, bolPhotoPath = null, truckPhotoPath = null;
    
    if (req.files) {
      for (const [fieldName, files] of Object.entries(req.files)) {
        if (files && files[0]) {
          try {
            const resized = files[0].path + '_resized.jpg';
            await sharp(files[0].path).resize(1200, null, { withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(resized);
            fs.unlinkSync(files[0].path);
            fs.renameSync(resized, files[0].path);
          } catch (e) { /* keep original */ }
          const relativePath = path.relative(PHOTO_DIR, files[0].path);
          if (fieldName === 'dl_photo') dlPhotoPath = relativePath;
          else if (fieldName === 'bol_photo') bolPhotoPath = relativePath;
          else if (fieldName === 'truck_photo') truckPhotoPath = relativePath;
        }
      }
    }

    const riskResult = calculateRiskScore({ ...data, site_id: req.user.site_id });
    const hashInput = JSON.stringify({ dl_number: data.dl_number, timestamp: new Date().toISOString(), site_id: req.user.site_id, guard_id: req.user.id });
    const integrityHash = crypto.createHash('sha256').update(hashInput).digest('hex');

    db.prepare(`
      INSERT INTO scans (
        id, guard_id, site_id, dl_number, dl_state, first_name, last_name, middle_name,
        date_of_birth, expiration_date, address_street, address_city, address_state, address_zip,
        gender, eye_color, height, weight,
        carrier_name, carrier_mc_number, carrier_dot_number,
        truck_plate, trailer_number, bol_number,
        dl_photo_path, bol_photo_path, truck_photo_path,
        risk_score, risk_flags, alert_level,
        latitude, longitude, integrity_hash, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scanId, req.user.id, req.user.site_id || 'unassigned',
      data.dl_number || null, data.dl_state || null,
      data.first_name || null, data.last_name || null, data.middle_name || null,
      data.date_of_birth || null, data.expiration_date || null,
      data.address_street || null, data.address_city || null,
      data.address_state || null, data.address_zip || null,
      data.gender || null, data.eye_color || null, data.height || null, data.weight || null,
      data.carrier_name || null, data.carrier_mc_number || null, data.carrier_dot_number || null,
      data.truck_plate || null, data.trailer_number || null, data.bol_number || null,
      dlPhotoPath, bolPhotoPath, truckPhotoPath,
      riskResult.score, JSON.stringify(riskResult.flags), riskResult.alertLevel,
      data.latitude ? parseFloat(data.latitude) : null, data.longitude ? parseFloat(data.longitude) : null,
      integrityHash, data.notes || null
    );

    audit(req.user.id, 'SCAN_CREATED', `Scan ${scanId} - DL: ${data.dl_number || 'N/A'} - Risk: ${riskResult.alertLevel}`, req.ip);
    res.json({ id: scanId, risk_score: riskResult.score, risk_flags: riskResult.flags, alert_level: riskResult.alertLevel, integrity_hash: integrityHash });
  } catch (err) {
    console.error('[SCAN ERROR]', err);
    res.status(500).json({ error: 'Failed to save scan' });
  }
});

app.get('/api/scans', authenticateToken, (req, res) => {
  const { limit = 50, offset = 0, alert_level, date_from, date_to } = req.query;
  let where = [], params = [];
  if (req.user.role === 'guard' && req.user.site_id) { where.push('s.site_id = ?'); params.push(req.user.site_id); }
  if (alert_level) { where.push('s.alert_level = ?'); params.push(alert_level); }
  if (date_from) { where.push('s.scan_timestamp >= ?'); params.push(date_from); }
  if (date_to) { where.push('s.scan_timestamp <= ?'); params.push(date_to); }
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const scans = db.prepare(`SELECT s.*, u.full_name as guard_name, si.name as site_name FROM scans s LEFT JOIN users u ON s.guard_id = u.id LEFT JOIN sites si ON s.site_id = si.id ${whereClause} ORDER BY s.scan_timestamp DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), parseInt(offset));
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM scans s ${whereClause}`).get(...params);
  res.json({ scans, total: total.cnt });
});

app.get('/api/scans/:id', authenticateToken, (req, res) => {
  const scan = db.prepare(`SELECT s.*, u.full_name as guard_name, si.name as site_name FROM scans s LEFT JOIN users u ON s.guard_id = u.id LEFT JOIN sites si ON s.site_id = si.id WHERE s.id = ?`).get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json(scan);
});

app.get('/api/scans/driver/:dl_number', authenticateToken, (req, res) => {
  const scans = db.prepare(`SELECT s.*, u.full_name as guard_name, si.name as site_name FROM scans s LEFT JOIN users u ON s.guard_id = u.id LEFT JOIN sites si ON s.site_id = si.id WHERE s.dl_number = ? ORDER BY s.scan_timestamp DESC`).all(req.params.dl_number);
  res.json({ scans, total: scans.length });
});

// ═══════════════════════════════════════════════════════════
// WATCHLIST ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/api/watchlist', authenticateToken, (req, res) => {
  const entries = db.prepare("SELECT w.*, u.full_name as added_by_name FROM watchlist w LEFT JOIN users u ON w.added_by = u.id WHERE w.active = 1 ORDER BY w.added_at DESC").all();
  res.json(entries);
});

app.post('/api/watchlist', authenticateToken, (req, res) => {
  const { dl_number, dl_state, first_name, last_name, reason, severity } = req.body;
  if (!dl_number || !reason) return res.status(400).json({ error: 'DL number and reason required' });
  const id = uuidv4();
  db.prepare("INSERT INTO watchlist (id, dl_number, dl_state, first_name, last_name, reason, severity, added_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, dl_number, dl_state || null, first_name || null, last_name || null, reason, severity || 'YELLOW', req.user.id);
  audit(req.user.id, 'WATCHLIST_ADD', `Added ${dl_number} - ${reason}`, req.ip);
  res.json({ id, message: 'Added to watchlist' });
});

app.delete('/api/watchlist/:id', authenticateToken, (req, res) => {
  db.prepare("UPDATE watchlist SET active = 0 WHERE id = ?").run(req.params.id);
  audit(req.user.id, 'WATCHLIST_REMOVE', `Deactivated ${req.params.id}`, req.ip);
  res.json({ message: 'Removed from watchlist' });
});

// ═══════════════════════════════════════════════════════════
// DASHBOARD ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/api/dashboard/stats', authenticateToken, requireRole('admin', 'supervisor'), (req, res) => {
  const today = db.prepare("SELECT COUNT(*) as cnt FROM scans WHERE date(scan_timestamp) = date('now')").get();
  const week = db.prepare("SELECT COUNT(*) as cnt FROM scans WHERE scan_timestamp > datetime('now', '-7 days')").get();
  const month = db.prepare("SELECT COUNT(*) as cnt FROM scans WHERE scan_timestamp > datetime('now', '-30 days')").get();
  const byAlert = db.prepare("SELECT alert_level, COUNT(*) as cnt FROM scans WHERE scan_timestamp > datetime('now', '-7 days') GROUP BY alert_level").all();
  const topDrivers = db.prepare("SELECT dl_number, first_name, last_name, COUNT(*) as scan_count, MAX(alert_level) as max_alert FROM scans WHERE scan_timestamp > datetime('now', '-30 days') AND dl_number IS NOT NULL GROUP BY dl_number ORDER BY scan_count DESC LIMIT 10").all();
  const bySite = db.prepare("SELECT si.name as site_name, COUNT(*) as cnt FROM scans s JOIN sites si ON s.site_id = si.id WHERE s.scan_timestamp > datetime('now', '-7 days') GROUP BY s.site_id ORDER BY cnt DESC").all();
  const byHour = db.prepare("SELECT CAST(strftime('%H', scan_timestamp) AS INTEGER) as hour, COUNT(*) as cnt FROM scans WHERE date(scan_timestamp) = date('now') GROUP BY hour ORDER BY hour").all();
  const recentRed = db.prepare("SELECT s.*, u.full_name as guard_name, si.name as site_name FROM scans s LEFT JOIN users u ON s.guard_id = u.id LEFT JOIN sites si ON s.site_id = si.id WHERE s.alert_level = 'RED' ORDER BY s.scan_timestamp DESC LIMIT 5").all();
  const watchlistCount = db.prepare("SELECT COUNT(*) as cnt FROM watchlist WHERE active = 1").get();
  res.json({ today: today.cnt, week: week.cnt, month: month.cnt, byAlert, topDrivers, bySite, byHour, recentRed, watchlistCount: watchlistCount.cnt });
});

// ═══════════════════════════════════════════════════════════
// USER / SITE MANAGEMENT
// ═══════════════════════════════════════════════════════════
app.get('/api/users', authenticateToken, requireRole('admin'), (req, res) => {
  const users = db.prepare("SELECT u.id, u.username, u.role, u.full_name, u.site_id, u.created_at, u.last_login, s.name as site_name FROM users u LEFT JOIN sites s ON u.site_id = s.id ORDER BY u.created_at DESC").all();
  res.json(users);
});

app.post('/api/users', authenticateToken, requireRole('admin'), (req, res) => {
  const { username, password, role, full_name, site_id } = req.body;
  if (!username || !password || !full_name) return res.status(400).json({ error: 'Username, password, and full name required' });
  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return res.status(409).json({ error: 'Username already exists' });
  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO users (id, username, password_hash, role, full_name, site_id) VALUES (?, ?, ?, ?, ?, ?)").run(id, username, hash, role || 'guard', full_name, site_id || null);
  audit(req.user.id, 'USER_CREATED', `Created user ${username} (${role || 'guard'})`, req.ip);
  res.json({ id, message: 'User created' });
});

app.get('/api/sites', authenticateToken, (req, res) => {
  res.json(db.prepare("SELECT * FROM sites ORDER BY name").all());
});

app.post('/api/sites', authenticateToken, requireRole('admin'), (req, res) => {
  const { name, address, city, state, client_name } = req.body;
  if (!name) return res.status(400).json({ error: 'Site name required' });
  const id = uuidv4();
  db.prepare("INSERT INTO sites (id, name, address, city, state, client_name) VALUES (?, ?, ?, ?, ?, ?)").run(id, name, address || null, city || null, state || 'TN', client_name || null);
  audit(req.user.id, 'SITE_CREATED', `Created site ${name}`, req.ip);
  res.json({ id, message: 'Site created' });
});

// ═══════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════
app.get('/api/export/scans', authenticateToken, requireRole('admin', 'supervisor'), (req, res) => {
  const { date_from, date_to } = req.query;
  let where = [], params = [];
  if (date_from) { where.push('scan_timestamp >= ?'); params.push(date_from); }
  if (date_to) { where.push('scan_timestamp <= ?'); params.push(date_to); }
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const scans = db.prepare(`SELECT s.*, u.full_name as guard_name, si.name as site_name FROM scans s LEFT JOIN users u ON s.guard_id = u.id LEFT JOIN sites si ON s.site_id = si.id ${whereClause} ORDER BY s.scan_timestamp DESC`).all(...params);
  const headers = ['Timestamp','Guard','Site','DL#','State','Name','DOB','Expiration','Carrier','MC#','DOT#','Plate','Trailer','BOL','Risk Score','Alert','Latitude','Longitude'];
  const rows = scans.map(s => [s.scan_timestamp, s.guard_name, s.site_name, s.dl_number, s.dl_state, `${s.first_name || ''} ${s.last_name || ''}`.trim(), s.date_of_birth, s.expiration_date, s.carrier_name, s.carrier_mc_number, s.carrier_dot_number, s.truck_plate, s.trailer_number, s.bol_number, s.risk_score, s.alert_level, s.latitude, s.longitude].map(v => `"${(v || '').toString().replace(/"/g, '""')}"`).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=shield_scans_${new Date().toISOString().slice(0,10)}.csv`);
  res.send(csv);
});

app.use('/photos', authenticateToken, express.static(PHOTO_DIR));

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/photos')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n  ╔════════════════════════════════════════╗`);
  console.log(`  ║   VANGUARD SHIELD v2.0                 ║`);
  console.log(`  ║   Running on port ${PORT}                ║`);
  console.log(`  ║   Photo Capture + Server Decode        ║`);
  console.log(`  ╚════════════════════════════════════════╝\n`);
});
