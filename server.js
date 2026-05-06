// server.js — Iron Halo Verify / Vanguard Shield v4.2
//
// Operational verification layer for logistics handoffs with tamper-evident
// audit receipts. Stateless verification gatekeeper, not data warehouse.
//
// v4.2 adds the Vanguard Shield intelligence layer (/api/intel) which calls
// OpenAI Chat Completions over the recent scan tape to surface anomalies
// for the operator dashboard. Intelligence layer is admin-only and entirely
// gated by OPENAI_INTEL_ENABLED + OPENAI_API_KEY env vars; the core
// verification path runs identically with or without it.
//
// Credentials: ALL secrets come from the environment. Nothing is hardcoded.
// Required: JWT_SECRET, JWT_REFRESH_SECRET. Optional: ALLOWED_ORIGINS,
// ADMIN_BOOTSTRAP_USERNAME / _PASSWORD (one-time), GUARD_BOOTSTRAP_*,
// DB_PATH, PORT, NODE_ENV, OPENAI_API_KEY, OPENAI_MODEL, OPENAI_INTEL_ENABLED.

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const { initialize: initDb } = require('./db/init');
const { closeDb } = require('./db/connection');
const { generalLimiter } = require('./middleware/ratelimit');

const VERSION = '4.2.0';

// ---------------------------------------------------------------------------
// Fail-fast config validation. Server never boots with weak/missing secrets.
// ---------------------------------------------------------------------------
function validateConfig() {
  const missing = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) missing.push('JWT_SECRET (>=32 chars)');
  if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET.length < 32) missing.push('JWT_REFRESH_SECRET (>=32 chars)');
  if (process.env.JWT_SECRET && process.env.JWT_REFRESH_SECRET && process.env.JWT_SECRET === process.env.JWT_REFRESH_SECRET) {
    missing.push('JWT_SECRET and JWT_REFRESH_SECRET must differ');
  }
  if (missing.length) {
    console.error('[startup] FATAL: required env vars missing or weak:');
    for (const m of missing) console.error('  -', m);
    console.error('[startup] copy .env.example to .env and run `openssl rand -hex 64` for each secret.');
    process.exit(1);
  }
}

validateConfig();

// ---------------------------------------------------------------------------
// DB init - idempotent, safe to run on every cold-start.
// ---------------------------------------------------------------------------
try {
  initDb();
} catch (err) {
  console.error('[startup] DB init failed:', err);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Trust the Render reverse proxy so req.ip / rate-limit keying is correct.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: false // index.html loads Dynamsoft from CDN
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);              // same-origin / mobile webview
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('cors_origin_rejected'));
  },
  credentials: false
}));

app.use(express.json({ limit: '6mb' }));
app.use(express.static('public'));

// Lightweight structured request log. One line per request, no body bytes.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      m: req.method,
      u: req.originalUrl,
      s: res.statusCode,
      ms
    });
    if (res.statusCode >= 500) console.error(line);
    else console.log(line);
  });
  next();
});

// General rate limit on all /api/.
app.use('/api/', generalLimiter);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/scans',      require('./routes/scans'));
app.use('/api/dashboard',  require('./routes/dashboard'));
app.use('/api/intel',      require('./routes/intel'));   // Vanguard Shield intelligence layer

// Health: cheap, unauthenticated, includes feature flags so the operator
// dashboard can reflect the running posture.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: VERSION,
    engine: 'dynamsoft-v11',
    intel_enabled: process.env.OPENAI_INTEL_ENABLED === '1' && !!process.env.OPENAI_API_KEY,
    node_env: NODE_ENV,
    server_time: new Date().toISOString()
  });
});

// 404 for any unmatched /api/* path - keeps the static handler from swallowing.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

// ---------------------------------------------------------------------------
// Error handler. CORS rejects -> 403, anything else -> 500. Body is never
// echoed back; only the message is logged.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[error]', req.method, req.originalUrl, '-', err.message);
  if (err.message === 'cors_origin_rejected') {
    return res.status(403).json({ error: 'cors_origin_rejected' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  return res.status(500).json({ error: 'internal_error' });
});

// ---------------------------------------------------------------------------
// Boot + graceful shutdown.
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(JSON.stringify({
    t: new Date().toISOString(),
    evt: 'startup',
    version: VERSION,
    port: PORT,
    node_env: NODE_ENV,
    intel_enabled: process.env.OPENAI_INTEL_ENABLED === '1' && !!process.env.OPENAI_API_KEY,
    cors_origins: allowedOrigins.length ? allowedOrigins : ['*']
  }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ t: new Date().toISOString(), evt: 'shutdown', signal }));
  server.close((err) => {
    try { closeDb(); } catch (_) {}
    if (err) {
      console.error('[shutdown] server.close error:', err.message);
      process.exit(1);
    }
    process.exit(0);
  });
  // Hard kill if cleanup hangs.
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  // Let the platform restart us; do not try to keep limping.
  shutdown('uncaughtException');
});

module.exports = app;
