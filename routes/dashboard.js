// routes/dashboard.js
// Client-facing dashboard routes. Per-client filtering: clients see only
// scans for their own sites. v1.1: polling-based default, SSE optional layer.

const express = require('express');
const { getDb } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');
const { dashboardLimiter } = require('../middleware/ratelimit');

const router = express.Router();

// GET /api/dashboard/scans/:site_id  (client must own site, admin can view any)
router.get('/scans/:site_id', requireAuth(['client', 'admin']), dashboardLimiter, (req, res) => {
  const db = getDb();
  const site_id = req.params.site_id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const since = req.query.since;

  const site = db.prepare('SELECT id, client_id FROM sites WHERE id = ?').get(site_id);
  if (!site) {
    return res.status(404).json({ error: 'unknown_site' });
  }
  if (req.user.role === 'client' && site.client_id !== req.user.client_id) {
    return res.status(403).json({ error: 'site_not_yours' });
  }

  let rows;
  if (since) {
    rows = db.prepare(`
      SELECT id, guard_id, site_id, scan_type, identifier_short, result, reason,
             timestamp, this_chain_hash
      FROM scans
      WHERE site_id = ? AND timestamp > ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(site_id, since, limit);
  } else {
    rows = db.prepare(`
      SELECT id, guard_id, site_id, scan_type, identifier_short, result, reason,
             timestamp, this_chain_hash
      FROM scans
      WHERE site_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(site_id, limit);
  }

  return res.json({
    site_id,
    server_time: new Date().toISOString(),
    scans: rows
  });
});

module.exports = router;
