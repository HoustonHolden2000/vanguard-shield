// server.js — Iron Halo Verify v4.1
// Operational verification layer for logistics handoffs with tamper-evident
// audit receipts. Stateless verification gatekeeper, not data warehouse.

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const { initialize: initDb } = require('./db/init');
const { generalLimiter } = require('./middleware/ratelimit');

// Initialize DB on cold-start (idempotent).
try {
  initDb();
} catch (err) {
  console.error('[startup] DB init failed:', err);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust the Render reverse proxy so req.ip is correct.
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false // index.html loads Dynamsoft from CDN
}));

// CORS: allowlist comma-separated origins from env, default to same-origin only.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow same-origin / mobile webview
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('cors_origin_rejected'));
  },
  credentials: false
}));

app.use(express.json({ limit: '6mb' }));
app.use(express.static('public'));

// General rate limit on everything below.
app.use('/api/', generalLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/scans', require('./routes/scans'));
app.use('/api/dashboard', require('./routes/dashboard'));

// Health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '4.1.0',
    engine: 'dynamsoft-v11',
    server_time: new Date().toISOString()
  });
});

// Error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[error]', err.message);
  if (err.message === 'cors_origin_rejected') {
    return res.status(403).json({ error: 'cors_origin_rejected' });
  }
  return res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`Iron Halo Verify v4.1 running on port ${PORT}`);
});
