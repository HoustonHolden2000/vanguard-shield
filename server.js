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
// BARCODE ENGINE LOADER
// Primary: Dynamsoft barcode4nodejs (optional native dep)
// Fallback: @zxing/library (pure JS, always available)
// ═══════════════════════════════════════════════════════════
let dbr = null;       // Dynamsoft barcode4nodejs
let ZXing = null;     // @zxing/library
let decodeEngine = 'none';

// Try Dynamsoft first
try {
  dbr = require('barcode4nodejs');
  const dynLicense = process.env.DYNAMSOFT_LICENSE || '';
  if (dynLicense) {
    dbr.initLicense(dynLicense);
    decodeEngine = 'dynamsoft';
    console.log('[BARCODE] Dynamsoft barcode4nodejs loaded (primary engine)');
  } else {
    console.log('[BARCODE] Dynamsoft loaded but no DYNAMSOFT_LICENSE env var — skipping');
    dbr = null;
  }
} catch (e) {
  console.log('[BARCODE] Dynamsoft barcode4nodejs not available:', e.message);
}

// ZXing fallback (always available)
try {
  ZXing = require('@zxing/library');
  if (!decodeEngine || decodeEngine === 'none') decodeEngine = 'zxing';
  console.log(`[BARCODE] ZXing loaded (${dbr ? 'fallback' : 'primary'} engine)`);
} catch (e) {
  console.log('[BARCODE] ZXing not available:', e.message);
}

if (decodeEngine === 'none') {
  console.warn('[BARCODE] WARNING: No barcode decode engine available!');
}

// ═══════════════════════════════════════════════════════════
// decodePdf417FromFile(filePath) — SINGLE DECODE ENTRY POINT
// This is the ONE function the rest of the app calls to decode
// a driver license barcode. To swap engines (e.g. Google ML Kit,
// Dynamsoft, or a future native SDK), change only this function.
// The front end and endpoint never touch barcode logic directly.
//
// Tries Dynamsoft first, then ZXing with multiple preprocessing
// variants. Only attempts PDF417 (the US DL standard).
// Returns: { text, engine, format, debugLog[] } or null
// ═══════════════════════════════════════════════════════════
async function decodePdf417FromFile(filePath) {
  const debugLog = [];
  const flat = { background: { r: 255, g: 255, b: 255 } };

  // Log input image info
  try {
    const meta = await sharp(filePath).metadata();
    debugLog.push(`input: ${meta.width}x${meta.height} ${meta.format} ${meta.channels}ch ${meta.space || 'unknown'}`);
    console.log(`[BARCODE] Input image: ${meta.width}x${meta.height} ${meta.format} ${meta.channels}ch`);
  } catch (e) {
    debugLog.push(`input metadata error: ${e.message}`);
  }

  // --- DYNAMSOFT (primary) ---
  if (dbr) {
    try {
      // Try PDF417 first
      const results = await new Promise((resolve, reject) => {
        dbr.decodeFileAsync(filePath, dbr.formats.PDF417, (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
      console.log(`[BARCODE] Dynamsoft PDF417 results: ${results ? results.length : 0} barcode(s) found`);
      debugLog.push(`dynamsoft_pdf417: ${results ? results.length : 0} result(s)`);

      if (results && results.length > 0) {
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          const fmt = r.format || r.barcodeFormatString || 'unknown';
          const txt = r.value || r.barcodeText || '';
          console.log(`[BARCODE]   result[${i}]: format=${fmt} len=${txt.length} text=${txt.substring(0, 80)}`);
          debugLog.push(`  [${i}] format=${fmt} len=${txt.length} text=${txt.substring(0, 80)}`);
        }
        if (results[0].value && results[0].value.length > 20) {
          return { text: results[0].value, engine: 'dynamsoft', format: 'PDF417', debugLog };
        }
      }

      // Try ALL formats to see if Dynamsoft finds anything else
      const allResults = await new Promise((resolve, reject) => {
        dbr.decodeFileAsync(filePath, dbr.formats.ALL, (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
      console.log(`[BARCODE] Dynamsoft ALL-FORMAT results: ${allResults ? allResults.length : 0} barcode(s) found`);
      debugLog.push(`dynamsoft_all: ${allResults ? allResults.length : 0} result(s)`);
      if (allResults && allResults.length > 0) {
        for (let i = 0; i < allResults.length; i++) {
          const r = allResults[i];
          const fmt = r.format || r.barcodeFormatString || 'unknown';
          const txt = r.value || r.barcodeText || '';
          console.log(`[BARCODE]   all[${i}]: format=${fmt} len=${txt.length} text=${txt.substring(0, 80)}`);
          debugLog.push(`  all[${i}] format=${fmt} len=${txt.length} text=${txt.substring(0, 80)}`);
        }
      }
    } catch (e) {
      console.error('[BARCODE] Dynamsoft decode error:', e.message);
      debugLog.push(`dynamsoft_error: ${e.message}`);
    }
  }

  // --- ZXING ---
  if (ZXing) {
    // Variant pipeline: different sharp preprocessing for each attempt
    // .flatten() composites alpha onto white — critical for PNGs with transparency
    const variantDefs = [
      { name: 'full-res+normalize',    fn: () => sharp(filePath).flatten(flat).grayscale().normalize().raw().toBuffer({ resolveWithObject: true }) },
      { name: '1600w+normalize',       fn: () => sharp(filePath).flatten(flat).resize(1600, null, { withoutEnlargement: true }).grayscale().normalize().raw().toBuffer({ resolveWithObject: true }) },
      { name: '2400w+normalize',       fn: () => sharp(filePath).flatten(flat).resize(2400, null, { withoutEnlargement: true }).grayscale().normalize().raw().toBuffer({ resolveWithObject: true }) },
      { name: '1600w+sharpen',         fn: () => sharp(filePath).flatten(flat).resize(1600, null, { withoutEnlargement: true }).grayscale().sharpen({ sigma: 2 }).normalize().raw().toBuffer({ resolveWithObject: true }) },
      { name: '1600w+highcontrast',    fn: () => sharp(filePath).flatten(flat).resize(1600, null, { withoutEnlargement: true }).grayscale().linear(1.5, -30).raw().toBuffer({ resolveWithObject: true }) },
      { name: '1600w+threshold',       fn: () => sharp(filePath).flatten(flat).resize(1600, null, { withoutEnlargement: true }).grayscale().threshold(128).raw().toBuffer({ resolveWithObject: true }) },
      { name: 'full-res+sharpen',      fn: () => sharp(filePath).flatten(flat).grayscale().sharpen({ sigma: 3 }).normalize().raw().toBuffer({ resolveWithObject: true }) },
      { name: '1600w+rotate90',        fn: () => sharp(filePath).flatten(flat).rotate(90).resize(1600, null, { withoutEnlargement: true }).grayscale().normalize().raw().toBuffer({ resolveWithObject: true }) },
    ];

    // PDF417-only reader
    const pdf417Hints = new Map();
    pdf417Hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.PDF_417]);
    pdf417Hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const pdf417Reader = new ZXing.MultiFormatReader();
    pdf417Reader.setHints(pdf417Hints);

    // Any-format reader (diagnostic)
    const anyHints = new Map();
    anyHints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    const anyReader = new ZXing.MultiFormatReader();
    anyReader.setHints(anyHints);

    for (let i = 0; i < variantDefs.length; i++) {
      const v = variantDefs[i];
      try {
        const { data, info } = await v.fn();
        const luminance = new Uint8ClampedArray(data);
        const source = new ZXing.RGBLuminanceSource(luminance, info.width, info.height);

        // Try PDF417 first
        try {
          const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
          const result = pdf417Reader.decode(bitmap);
          if (result && result.getText()) {
            const txt = result.getText();
            const fmt = result.getBarcodeFormat ? result.getBarcodeFormat().toString() : 'PDF_417';
            console.log(`[BARCODE] ZXing [${v.name}] PDF417 HIT: len=${txt.length} fmt=${fmt} text=${txt.substring(0, 80)}`);
            debugLog.push(`zxing_${v.name}: PDF417 HIT len=${txt.length}`);
            if (txt.length > 20) {
              return { text: txt, engine: 'zxing', format: fmt, variant: v.name, debugLog };
            }
          }
        } catch (e) {
          // PDF417 not found in this variant
        }

        // Try ANY format (diagnostic — find what ZXing CAN see)
        try {
          const source2 = new ZXing.RGBLuminanceSource(luminance, info.width, info.height);
          const bitmap2 = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source2));
          const result2 = anyReader.decode(bitmap2);
          if (result2 && result2.getText()) {
            const txt = result2.getText();
            const fmt = result2.getBarcodeFormat ? result2.getBarcodeFormat().toString() : 'unknown';
            console.log(`[BARCODE] ZXing [${v.name}] ANY-FORMAT HIT: fmt=${fmt} len=${txt.length} text=${txt.substring(0, 80)}`);
            debugLog.push(`zxing_${v.name}: ANY-HIT fmt=${fmt} len=${txt.length} text=${txt.substring(0, 60)}`);
          }
        } catch (e) {
          // Nothing found at all in this variant
        }

        debugLog.push(`zxing_${v.name}: ${info.width}x${info.height} no_pdf417`);
      } catch (e) {
        console.log(`[BARCODE] ZXing [${v.name}] sharp error: ${e.message}`);
        debugLog.push(`zxing_${v.name}: sharp_error ${e.message}`);
      }
    }
    console.log('[BARCODE] ZXing: all variants failed');
  }

  return { text: null, engine: 'none', format: null, debugLog };
}

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
// PHASE 2 SCHEMA MIGRATION
// ═══════════════════════════════════════════════════════════
const migrations = [
  "ALTER TABLE scans ADD COLUMN pickup_reference TEXT",
  "ALTER TABLE scans ADD COLUMN destination TEXT",
  "ALTER TABLE scans ADD COLUMN scheduled_pickup TEXT",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* column already exists */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS expected_pickups (
    id TEXT PRIMARY KEY,
    bol_number TEXT NOT NULL,
    carrier_name TEXT,
    pickup_reference TEXT,
    destination TEXT,
    scheduled_date TEXT,
    scheduled_time_start TEXT,
    scheduled_time_end TEXT,
    site_id TEXT,
    status TEXT DEFAULT 'PENDING',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );
  CREATE INDEX IF NOT EXISTS idx_expected_bol ON expected_pickups(bol_number);
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

// Seed expected pickups for demo (if table is empty)
const demoSite = db.prepare("SELECT id FROM sites LIMIT 1").get();
if (demoSite) {
  const existingPickup = db.prepare("SELECT id FROM expected_pickups LIMIT 1").get();
  if (!existingPickup) {
    const pickups = [
      { bol: 'BOL-2026-001', carrier: 'Swift Transport', ref: 'PU-5521', dest: 'Nashville, TN', date: '2026-03-01', start: '06:00', end: '18:00' },
      { bol: 'BOL-2026-002', carrier: 'FedEx Freight', ref: 'PU-8834', dest: 'Atlanta, GA', date: '2026-03-01', start: '07:00', end: '15:00' },
      { bol: 'BOL-2026-003', carrier: 'XPO Logistics', ref: 'PU-3301', dest: 'Birmingham, AL', date: '2026-03-02', start: '08:00', end: '16:00' },
      { bol: 'BOL-2026-004', carrier: 'Old Dominion', ref: 'PU-7710', dest: 'Memphis, TN', date: '2026-03-03', start: '05:00', end: '14:00' },
      { bol: 'BOL-2026-005', carrier: 'Estes Express', ref: 'PU-2290', dest: 'Jackson, MS', date: '2026-03-03', start: '09:00', end: '17:00' },
    ];
    const stmt = db.prepare("INSERT INTO expected_pickups (id, bol_number, carrier_name, pickup_reference, destination, scheduled_date, scheduled_time_start, scheduled_time_end, site_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const p of pickups) {
      stmt.run(uuidv4(), p.bol, p.carrier, p.ref, p.dest, p.date, p.start, p.end, demoSite.id);
    }
    console.log('[INIT] Seeded 5 expected pickups for demo');
  }
}

// ═══════════════════════════════════════════════════════════
// AAMVA PDF417 PARSER (server-side)
// Returns: { first_name, last_name, middle_name, address, city,
//            state, postal_code, dob, dl_number, expiration,
//            gender, eye_color, height, raw }
// ═══════════════════════════════════════════════════════════
function parseAamva(raw) {
  const r = {};
  const lines = raw.split(/[\n\r\x1e\x1d]+/);
  for (const line of lines) {
    let t = line.trim();
    // Strip "DL" subfile designator that runs into the first field
    // e.g. "DLDAQ067041259" → "DAQ067041259"
    if (/^DL[A-Z]{3}/.test(t)) t = t.substring(2);
    if (t.startsWith('DAC')) r.first_name = t.substring(3).trim();
    else if (t.startsWith('DCT') && !r.first_name) r.first_name = t.substring(3).trim();
    else if (t.startsWith('DCS')) r.last_name = t.substring(3).trim();
    else if (t.startsWith('DAB') && !r.last_name) r.last_name = t.substring(3).trim();
    else if (t.startsWith('DAD')) r.middle_name = t.substring(3).trim();
    else if (t.startsWith('DAG')) r.address = t.substring(3).trim();
    else if (t.startsWith('DAI')) r.city = t.substring(3).trim();
    else if (t.startsWith('DAJ')) r.state = t.substring(3).trim();
    else if (t.startsWith('DAK')) r.postal_code = t.substring(3).trim();
    else if (t.startsWith('DBB')) r.dob = t.substring(3).trim();
    else if (t.startsWith('DBA')) r.expiration = t.substring(3).trim();
    else if (t.startsWith('DAQ')) r.dl_number = t.substring(3).trim();
    else if (t.startsWith('DBC')) r.gender_code = t.substring(3).trim();
    else if (t.startsWith('DAY')) r.eye_color = t.substring(3).trim();
    else if (t.startsWith('DAU')) r.height_raw = t.substring(3).trim();
  }

  // Normalize dates (MMDDYYYY → YYYY-MM-DD, or YYYYMMDD → YYYY-MM-DD)
  for (const df of ['dob', 'expiration']) {
    if (r[df] && r[df].length >= 8) {
      const d = r[df].replace(/[^0-9]/g, '');
      if (d.length === 8) {
        const first2 = parseInt(d.slice(0, 2));
        if (first2 > 12) r[df] = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
        else r[df] = `${d.slice(4,8)}-${d.slice(0,2)}-${d.slice(2,4)}`;
      }
    }
  }

  // Clean postal code (first 5 digits)
  if (r.postal_code) r.postal_code = r.postal_code.substring(0, 5);

  // Title-case names
  for (const nf of ['first_name', 'last_name', 'middle_name', 'city']) {
    if (r[nf]) r[nf] = r[nf].charAt(0).toUpperCase() + r[nf].slice(1).toLowerCase();
  }

  // Gender: DBC 1=Male 2=Female 9=Not specified
  let gender = '';
  if (r.gender_code === '1') gender = 'Male';
  else if (r.gender_code === '2') gender = 'Female';
  else if (r.gender_code) gender = r.gender_code;

  // Eye color: DAY code → readable
  const eyeMap = { BLK: 'Black', BLU: 'Blue', BRO: 'Brown', GRY: 'Gray', GRN: 'Green', HAZ: 'Hazel', MAR: 'Maroon', PNK: 'Pink', DIC: 'Dichromatic', UNK: 'Unknown' };
  let eyeColor = '';
  if (r.eye_color) eyeColor = eyeMap[r.eye_color.toUpperCase()] || r.eye_color;

  // Height: DAU — formats vary: "072 IN", "072 in", "510", "5'-10\""
  let height = '';
  if (r.height_raw) {
    const h = r.height_raw.replace(/\s*(IN|in)\s*$/, '').trim();
    const inches = parseInt(h, 10);
    if (!isNaN(inches) && inches > 24 && inches < 96) {
      const ft = Math.floor(inches / 12);
      const rem = inches % 12;
      height = `${ft}'${rem}"`;
    } else {
      height = r.height_raw;
    }
  }

  return {
    first_name: r.first_name || '',
    last_name: r.last_name || '',
    middle_name: r.middle_name || '',
    address: r.address || '',
    city: r.city || '',
    state: r.state || '',
    postal_code: r.postal_code || '',
    dob: r.dob || '',
    dl_number: r.dl_number || '',
    expiration: r.expiration || '',
    gender: gender,
    eye_color: eyeColor,
    height: height,
    raw: raw,
  };
}

// ═══════════════════════════════════════════════════════════
// SCORING ENGINE v1 — Phase 2
// Starts at 100, deducts for mismatches.
// GREEN 85-100 | YELLOW 50-84 | RED 0-49
// Banned DL = force 0 | Watchlisted DL = cap 60
// ═══════════════════════════════════════════════════════════
function scoreScan(scanData) {
  let score = 100;
  const reasons = [];

  // ── Watchlist check (must be first — RED = instant 0) ──
  if (scanData.dl_number) {
    const watchHit = db.prepare("SELECT reason, severity FROM watchlist WHERE dl_number = ? AND active = 1").get(scanData.dl_number);
    if (watchHit && watchHit.severity === 'RED') {
      return { score: 0, reasons: ['BANNED DRIVER — ' + watchHit.reason], alertLevel: 'RED' };
    }
    if (watchHit) {
      reasons.push('WATCHLIST — ' + watchHit.reason);
    }
  }

  // ── BOL verification against ExpectedPickups ──
  let expectedPickup = null;
  if (scanData.bol_number) {
    expectedPickup = db.prepare("SELECT * FROM expected_pickups WHERE bol_number = ? AND status = 'PENDING'").get(scanData.bol_number);
    if (!expectedPickup) {
      score -= 40;
      reasons.push('BOL not found in expected pickups (−40)');
    } else {
      reasons.push('BOL verified — matches expected pickup');

      // Carrier match
      if (expectedPickup.carrier_name && scanData.carrier_name) {
        if (expectedPickup.carrier_name.toLowerCase().trim() !== scanData.carrier_name.toLowerCase().trim()) {
          score -= 20;
          reasons.push('Carrier mismatch: expected "' + expectedPickup.carrier_name + '" (−20)');
        } else {
          reasons.push('Carrier verified');
        }
      }

      // Destination match
      if (expectedPickup.destination && scanData.destination) {
        if (expectedPickup.destination.toLowerCase().trim() !== scanData.destination.toLowerCase().trim()) {
          score -= 10;
          reasons.push('Destination mismatch: expected "' + expectedPickup.destination + '" (−10)');
        } else {
          reasons.push('Destination verified');
        }
      }

      // Schedule match (date check)
      if (expectedPickup.scheduled_date) {
        const today = new Date().toISOString().slice(0, 10);
        const scheduledDate = expectedPickup.scheduled_date;
        if (today !== scheduledDate) {
          score -= 10;
          reasons.push('Schedule mismatch: expected ' + scheduledDate + ' (−10)');
        } else {
          reasons.push('Schedule verified — on time');
        }
      }
    }
  } else {
    score -= 40;
    reasons.push('No BOL number provided (−40)');
  }

  // ── Expired license ──
  if (scanData.expiration_date) {
    const parts = scanData.expiration_date.split('-');
    if (parts.length === 3) {
      const exp = new Date(parts[0], parts[1] - 1, parts[2]);
      if (exp < new Date()) {
        score -= 15;
        reasons.push('Expired license (−15)');
      }
    }
  }

  // ── No DL number ──
  if (!scanData.dl_number) {
    score -= 10;
    reasons.push('No DL number provided (−10)');
  }

  // ── YELLOW watchlist cap ──
  if (scanData.dl_number) {
    const watchHit = db.prepare("SELECT severity FROM watchlist WHERE dl_number = ? AND active = 1").get(scanData.dl_number);
    if (watchHit && watchHit.severity === 'YELLOW' && score > 60) {
      score = 60;
      reasons.push('Score capped at 60 (watchlist caution)');
    }
  }

  // Clamp 0-100
  score = Math.max(0, Math.min(100, score));

  let alertLevel = 'GREEN';
  if (score < 50) alertLevel = 'RED';
  else if (score < 85) alertLevel = 'YELLOW';

  return { score, reasons, alertLevel };
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
// DECODER INFO (debug route)
// ═══════════════════════════════════════════════════════════
app.get('/api/decoder-info', authenticateToken, (req, res) => {
  const info = {
    active_engine: decodeEngine,
    dynamsoft: {
      available: !!dbr,
      license_set: !!process.env.DYNAMSOFT_LICENSE,
      formats_pdf417: dbr ? !!dbr.formats.PDF417 : false,
      formats_all: dbr ? Object.keys(dbr.formats || {}) : [],
    },
    zxing: {
      available: !!ZXing,
      pdf417_format_value: ZXing ? ZXing.BarcodeFormat.PDF_417 : null,
      supported_formats: ZXing ? Object.keys(ZXing.BarcodeFormat).filter(k => !k.startsWith('_') && typeof ZXing.BarcodeFormat[k] === 'number') : [],
      decode_hints: {
        POSSIBLE_FORMATS: ['PDF_417'],
        TRY_HARDER: true,
      },
    },
    preprocessing: {
      variants: [
        'full-res+normalize (original resolution, no resize)',
        '1600w+normalize (standard)',
        '2400w+normalize (high-res)',
        '1600w+sharpen (sigma=2)',
        '1600w+highcontrast (linear 1.5x)',
        '1600w+threshold (128)',
        'full-res+sharpen (sigma=3)',
        '1600w+rotate90',
      ],
      flatten_alpha: true,
      jpeg_preprocess_quality: 95,
    },
    runtime: {
      node_version: process.version,
      platform: process.platform,
      sharp_version: sharp.versions ? sharp.versions.sharp : 'unknown',
    },
  };
  res.json(info);
});

// ═══════════════════════════════════════════════════════════
// BARCODE DECODE ENDPOINT
// Accepts: multipart file upload (field: "dlImage")
//      or: JSON { image: "<base64>" }
// Returns: { success, data, engine } or { success: false, error }
// ═══════════════════════════════════════════════════════════
app.post('/api/decode-dl', authenticateToken, upload.single('dlImage'), async (req, res) => {
  let tempPath = null;
  try {
    // Accept either file upload or base64 JSON
    if (req.file) {
      tempPath = req.file.path;
    } else if (req.body && req.body.image) {
      const imgBuffer = Buffer.from(req.body.image, 'base64');
      tempPath = path.join(PHOTO_DIR, `decode_${Date.now()}.jpg`);
      fs.writeFileSync(tempPath, imgBuffer);
    } else {
      return res.status(400).json({ success: false, error: 'No image provided' });
    }

    // Preprocess: save a clean JPEG for the decode engines
    // .flatten() composites alpha onto white — prevents PNGs with transparency from going black
    const preprocessedPath = tempPath + '_pre.jpg';
    await sharp(tempPath)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(1600, null, { withoutEnlargement: true })
      .jpeg({ quality: 95 })
      .toFile(preprocessedPath);

    // Decode PDF417
    const decodeResult = await decodePdf417FromFile(preprocessedPath);

    // Cleanup temp files
    try { fs.unlinkSync(tempPath); } catch (e) { /* */ }
    try { fs.unlinkSync(preprocessedPath); } catch (e) { /* */ }

    if (!decodeResult || !decodeResult.text) {
      return res.json({
        success: false,
        error: 'Could not read barcode. Conditions here are tough \u2013 please type the details from the card.',
        debug: {
          engine_attempted: decodeEngine,
          raw_barcode_text: null,
          raw_barcode_format: null,
          log: decodeResult ? decodeResult.debugLog : ['no decode result'],
        }
      });
    }

    const parsed = parseAamva(decodeResult.text);
    console.log(`[DECODE] Success (${decodeResult.engine}): ${parsed.first_name} ${parsed.last_name} DL:${parsed.dl_number}`);

    return res.json({
      success: true,
      data: parsed,
      engine: decodeResult.engine,
      debug: {
        raw_barcode_text: decodeResult.text,
        raw_barcode_format: decodeResult.format,
        variant_used: decodeResult.variant || null,
        log: decodeResult.debugLog,
      }
    });

  } catch (err) {
    console.error('[DECODE ERROR]', err);
    // Cleanup on error
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch (e) { /* */ } }
    try { fs.unlinkSync(tempPath + '_pre.jpg'); } catch (e) { /* */ }
    return res.json({ success: false, error: 'Image processing failed. Please try again.' });
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

    // Phase 2: scoring engine (starts at 100, deducts)
    const scoreResult = scoreScan({ ...data, site_id: req.user.site_id });
    const hashInput = JSON.stringify({ dl_number: data.dl_number, timestamp: new Date().toISOString(), site_id: req.user.site_id, guard_id: req.user.id });
    const integrityHash = crypto.createHash('sha256').update(hashInput).digest('hex');

    db.prepare(`
      INSERT INTO scans (
        id, guard_id, site_id, dl_number, dl_state, first_name, last_name, middle_name,
        date_of_birth, expiration_date, address_street, address_city, address_state, address_zip,
        gender, eye_color, height, weight,
        carrier_name, carrier_mc_number, carrier_dot_number,
        truck_plate, trailer_number, bol_number,
        pickup_reference, destination, scheduled_pickup,
        dl_photo_path, bol_photo_path, truck_photo_path,
        risk_score, risk_flags, alert_level,
        latitude, longitude, integrity_hash, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      data.pickup_reference || null, data.destination || null, data.scheduled_pickup || null,
      dlPhotoPath, bolPhotoPath, truckPhotoPath,
      scoreResult.score, JSON.stringify(scoreResult.reasons), scoreResult.alertLevel,
      data.latitude ? parseFloat(data.latitude) : null, data.longitude ? parseFloat(data.longitude) : null,
      integrityHash, data.notes || null
    );

    // Mark expected pickup as fulfilled if BOL matched
    if (data.bol_number) {
      db.prepare("UPDATE expected_pickups SET status = 'FULFILLED' WHERE bol_number = ? AND status = 'PENDING'").run(data.bol_number);
    }

    audit(req.user.id, 'SCAN_CREATED', `Scan ${scanId} - DL: ${data.dl_number || 'N/A'} - Score: ${scoreResult.score} ${scoreResult.alertLevel}`, req.ip);
    res.json({ id: scanId, risk_score: scoreResult.score, reasons: scoreResult.reasons, alert_level: scoreResult.alertLevel, integrity_hash: integrityHash });
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
// EXPECTED PICKUPS ROUTES
// ═══════════════════════════════════════════════════════════
app.get('/api/expected-pickups', authenticateToken, (req, res) => {
  const { status } = req.query;
  let where = [], params = [];
  if (status) { where.push('ep.status = ?'); params.push(status); }
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const pickups = db.prepare(`SELECT ep.*, s.name as site_name FROM expected_pickups ep LEFT JOIN sites s ON ep.site_id = s.id ${whereClause} ORDER BY ep.scheduled_date, ep.scheduled_time_start`).all(...params);
  res.json(pickups);
});

app.post('/api/expected-pickups', authenticateToken, requireRole('admin', 'supervisor'), (req, res) => {
  const { bol_number, carrier_name, pickup_reference, destination, scheduled_date, scheduled_time_start, scheduled_time_end, site_id } = req.body;
  if (!bol_number) return res.status(400).json({ error: 'BOL number required' });
  const id = uuidv4();
  db.prepare("INSERT INTO expected_pickups (id, bol_number, carrier_name, pickup_reference, destination, scheduled_date, scheduled_time_start, scheduled_time_end, site_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, bol_number, carrier_name || null, pickup_reference || null, destination || null, scheduled_date || null, scheduled_time_start || null, scheduled_time_end || null, site_id || null);
  audit(req.user.id, 'PICKUP_CREATED', `Expected pickup ${bol_number}`, req.ip);
  res.json({ id, message: 'Expected pickup created' });
});

app.delete('/api/expected-pickups/:id', authenticateToken, requireRole('admin', 'supervisor'), (req, res) => {
  db.prepare("DELETE FROM expected_pickups WHERE id = ?").run(req.params.id);
  audit(req.user.id, 'PICKUP_DELETED', `Deleted pickup ${req.params.id}`, req.ip);
  res.json({ message: 'Deleted' });
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
