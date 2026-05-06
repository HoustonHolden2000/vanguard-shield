// middleware/ratelimit.js
// Rate limit configurations per endpoint class.

const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_login_attempts', retry_after_minutes: 15 }
});

const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (req) => (req.user && req.user.id) ? `guard:${req.user.id}` : req.ip,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'scan_rate_exceeded' }
});

const dashboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  keyGenerator: (req) => (req.user && req.user.id) ? `client:${req.user.id}` : req.ip,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

module.exports = { loginLimiter, scanLimiter, dashboardLimiter, generalLimiter };
