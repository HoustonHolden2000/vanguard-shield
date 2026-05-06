// routes/intel.js
// Vanguard Shield Intelligence Layer (v4.2)
//
// Admin-only GPT/OpenAI integration. Reads recent scan tape from SQLite,
// shapes a deterministic operator-facing summary prompt, and asks the model
// to surface anomalies, expiring-license risk, and BoL handoff exceptions.
//
// Hard rules:
//   - PII never leaves the box. We send only payload_hash, scan_type, result,
//     reason, identifier_short, timestamp, site_id. No photo bytes, no full
//     payload strings, no raw license numbers.
//   - Endpoint is admin-only and rate-limited (dashboardLimiter).
//   - If OPENAI_API_KEY is unset or OPENAI_INTEL_ENABLED != "1", endpoint
//     returns 503 with a structured reason. No silent failure.
//   - Timeout: 25s wall-clock. Render free-tier requests die at 30s.

const express = require('express');
const { getDb } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');
const { dashboardLimiter } = require('../middleware/ratelimit');

const router = express.Router();

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_LOOKBACK_HOURS = 24;
const MAX_LOOKBACK_HOURS = 24 * 14;
const MAX_SCANS_FOR_PROMPT = 500;
const REQUEST_TIMEOUT_MS = 25000;

// Lazy-load openai SDK so the server still boots if the dep isn't installed
// in a stripped deployment. We surface a 503 in that case.
let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const { OpenAI } = require('openai');
    _openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: REQUEST_TIMEOUT_MS
    });
    return _openai;
  } catch (e) {
    console.error('[intel] openai sdk not installed:', e.message);
    return null;
  }
}

function intelEnabled() {
  return process.env.OPENAI_INTEL_ENABLED === '1' && !!process.env.OPENAI_API_KEY;
}

function summarizeScans(rows) {
  // Deterministic counters so the prompt has structure, not just a row dump.
  const counts = { total: rows.length, PASS: 0, FAIL: 0, PARTIAL: 0 };
  const reasons = {};
  const bySite = {};
  const byScanType = {};
  for (const r of rows) {
    counts[r.result] = (counts[r.result] || 0) + 1;
    if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    bySite[r.site_id] = (bySite[r.site_id] || 0) + 1;
    byScanType[r.scan_type] = (byScanType[r.scan_type] || 0) + 1;
  }
  return { counts, reasons, bySite, byScanType };
}

function buildPrompt(summary, rows, hours) {
  const sample = rows.slice(0, 50).map(r => ({
    t: r.timestamp,
    site: r.site_id,
    type: r.scan_type,
    result: r.result,
    reason: r.reason || null,
    id_short: r.identifier_short || null
  }));
  return [
    {
      role: 'system',
      content: 'You are the Vanguard Shield intelligence layer. You read tamper-evident scan logs from a logistics yard verification system and report operator-facing risk in tight, factual prose. No speculation beyond the data. No PII echoing. Output JSON only with keys: headline, anomalies (array of strings), expiring_risk (string), recommended_actions (array of strings).'
    },
    {
      role: 'user',
      content:
        `Lookback window: ${hours}h.\n` +
        `Aggregate: ${JSON.stringify(summary.counts)}\n` +
        `Failure reasons: ${JSON.stringify(summary.reasons)}\n` +
        `By site: ${JSON.stringify(summary.bySite)}\n` +
        `By scan type: ${JSON.stringify(summary.byScanType)}\n` +
        `Recent records (latest 50, hashed payload only): ${JSON.stringify(sample)}\n\n` +
        'Return ONLY a JSON object. No prose outside the JSON.'
    }
  ];
}

// GET /api/intel/health  - unauthenticated, reports config presence (no secrets)
router.get('/health', (req, res) => {
  res.json({
    intel_enabled: intelEnabled(),
    model: DEFAULT_MODEL,
    sdk_installed: !!getOpenAI() || !process.env.OPENAI_API_KEY ? !!getOpenAI() : false
  });
});

// POST /api/intel/summarize  (admin only)
//   body: { lookback_hours?: number, site_id?: string }
router.post('/summarize', requireAuth(['admin']), dashboardLimiter, async (req, res) => {
  if (!intelEnabled()) {
    return res.status(503).json({
      error: 'intel_disabled',
      detail: 'Set OPENAI_INTEL_ENABLED=1 and provide OPENAI_API_KEY in the environment.'
    });
  }
  const client = getOpenAI();
  if (!client) {
    return res.status(503).json({ error: 'openai_sdk_unavailable' });
  }

  const lookback = Math.min(
    Math.max(parseInt((req.body && req.body.lookback_hours), 10) || DEFAULT_LOOKBACK_HOURS, 1),
    MAX_LOOKBACK_HOURS
  );
  const siteFilter = req.body && typeof req.body.site_id === 'string' ? req.body.site_id : null;

  const db = getDb();
  const sinceIso = new Date(Date.now() - lookback * 3600 * 1000).toISOString();
  const rows = siteFilter
    ? db.prepare(`
        SELECT id, site_id, scan_type, result, reason, identifier_short, timestamp
        FROM scans
        WHERE timestamp > ? AND site_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(sinceIso, siteFilter, MAX_SCANS_FOR_PROMPT)
    : db.prepare(`
        SELECT id, site_id, scan_type, result, reason, identifier_short, timestamp
        FROM scans
        WHERE timestamp > ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(sinceIso, MAX_SCANS_FOR_PROMPT);

  if (rows.length === 0) {
    return res.json({
      lookback_hours: lookback,
      site_id: siteFilter,
      scans_considered: 0,
      report: {
        headline: 'No scans in lookback window.',
        anomalies: [],
        expiring_risk: 'n/a',
        recommended_actions: []
      },
      model: DEFAULT_MODEL
    });
  }

  const summary = summarizeScans(rows);
  const messages = buildPrompt(summary, rows, lookback);

  try {
    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      max_tokens: 800
    });
    const raw = completion.choices && completion.choices[0] && completion.choices[0].message
      ? completion.choices[0].message.content
      : '{}';
    let report;
    try {
      report = JSON.parse(raw);
    } catch (_) {
      report = { headline: 'Model returned non-JSON.', anomalies: [], expiring_risk: 'unknown', recommended_actions: [], raw };
    }
    return res.json({
      lookback_hours: lookback,
      site_id: siteFilter,
      scans_considered: rows.length,
      aggregate: summary,
      report,
      model: completion.model || DEFAULT_MODEL,
      usage: completion.usage || null
    });
  } catch (err) {
    console.error('[intel] openai call failed:', err.message);
    return res.status(502).json({
      error: 'openai_call_failed',
      detail: err.message,
      // We still hand the operator the deterministic aggregate so the call
      // is never wasted - they can act on raw counts even if the LLM is down.
      lookback_hours: lookback,
      site_id: siteFilter,
      scans_considered: rows.length,
      aggregate: summary
    });
  }
});

module.exports = router;
