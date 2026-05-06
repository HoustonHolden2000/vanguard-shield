// routes/scans.js
// Scan capture and history endpoints. v1.1: tamper-evident chain, validated
// payload, role-gated access.

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');
const { validateBody, scanSchema } = require('../middleware/validate');
const { scanLimiter } = require('../middleware/ratelimit');
const { appendScan, payloadHash, verifyChain } = require('../lib/audit-chain');
const { validate: validateScan } = require('../lib/scan-validator');

const router = express.Router();

// POST /api/scans  (guard or admin)
router.post('/', requireAuth(['guard', 'admin']), scanLimiter, validateBody(scanSchema), (req, res) => {
  const db = getDb();
  const { site_id, scan_type, payload, identifier_short, gps_lat, gps_lon, photo_b64, metadata } = req.body;

  // Verify the site exists and (for guards) belongs to a known site.
  const site = db.prepare('SELECT id, client_id FROM sites WHERE id = ?').get(site_id);
  if (!site) {
    return res.status(400).json({ error: 'unknown_site_id' });
  }

  // Parse the payload string. PDF417/BoL scanners typically deliver a string;
  // for v1.1 we accept either JSON or pipe-delimited; downstream parsers can
  // be added as new scan formats arrive.
  let decoded = null;
  try {
    decoded = JSON.parse(payload);
  } catch (_) {
    // Fallback: store payload as raw string under a generic key.
    decoded = { raw: payload };
  }

  const result = validateScan(scan_type, decoded);

  const photo_hash = photo_b64
    ? crypto.createHash('sha256').update(photo_b64).digest('hex')
    : null;

  const record = {
    id: uuidv4(),
    guard_id: req.user.id,
    site_id,
    scan_type,
    payload_hash: payloadHash(payload),
    identifier_short: identifier_short || null,
    result: result.result,
    reason: result.reason,
    gps_lat: gps_lat === undefined ? null : gps_lat,
    gps_lon: gps_lon === undefined ? null : gps_lon,
    photo_hash,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
    timestamp: new Date().toISOString(),
    prev_chain_hash: null,
    this_chain_hash: null
  };

  appendScan(db, record);

  return res.json({
    id: record.id,
    result: record.result,
    reason: record.reason,
    timestamp: record.timestamp,
    this_chain_hash: record.this_chain_hash
  });
});

// GET /api/scans/recent  (guard sees own site, admin sees all)
router.get('/recent', requireAuth(['guard', 'admin']), (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const site_id = req.query.site_id;
  let rows;
  if (req.user.role === 'admin') {
    rows = site_id
      ? db.prepare('SELECT * FROM scans WHERE site_id = ? ORDER BY timestamp DESC LIMIT ?').all(site_id, limit)
      : db.prepare('SELECT * FROM scans ORDER BY timestamp DESC LIMIT ?').all(limit);
  } else {
    rows = db.prepare('SELECT * FROM scans WHERE guard_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(req.user.id, limit);
  }
  return res.json({ scans: rows });
});

// GET /api/scans/audit  (admin only) - verify chain integrity
router.get('/audit', requireAuth(['admin']), (req, res) => {
  const db = getDb();
  const verdict = verifyChain(db);
  return res.json(verdict);
});

module.exports = router;
