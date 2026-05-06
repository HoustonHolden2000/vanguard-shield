// routes/auth.js
// Authentication routes: login, refresh, logout. v1.1 hardening:
// - bcrypt-hashed passwords (12 rounds)
// - JWT access tokens (1h)
// - JWT refresh tokens (24h) with revocation table + family invalidation

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const { getDb } = require('../db/connection');
const { validateBody, loginSchema, refreshSchema } = require('../middleware/validate');
const { loginLimiter } = require('../middleware/ratelimit');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ACCESS_TTL_SECONDS = 60 * 60;          // 1 hour
const REFRESH_TTL_SECONDS = 24 * 60 * 60;    // 24 hours

function uaHash(req) {
  return crypto.createHash('sha256').update(req.headers['user-agent'] || '').digest('hex').slice(0, 16);
}

function issueAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      client_id: user.client_id || null,
      name: user.name
    },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: ACCESS_TTL_SECONDS }
  );
}

function issueRefreshToken(db, user, familyId, ua) {
  const tokenId = uuidv4();
  const expiresAt = new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString();
  const ua_hash = ua;
  db.prepare(`
    INSERT INTO refresh_tokens (token_id, user_id, family_id, ua_hash, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(tokenId, user.id, familyId, ua_hash, expiresAt);
  const refreshJwt = jwt.sign(
    { jti: tokenId, sub: user.id, fam: familyId, ua: ua_hash },
    process.env.JWT_REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: REFRESH_TTL_SECONDS }
  );
  return refreshJwt;
}

function logAudit(db, userId, action, req, metadata) {
  try {
    db.prepare(`
      INSERT INTO audit_log (user_id, action, ip_address, ua_string, metadata_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      userId || null,
      action,
      (req.ip || '').slice(0, 64),
      (req.headers['user-agent'] || '').slice(0, 512),
      metadata ? JSON.stringify(metadata) : null
    );
  } catch (e) {
    console.error('[audit] log failed:', e.message);
  }
}

// POST /api/auth/login
router.post('/login', loginLimiter, validateBody(loginSchema), (req, res) => {
  const db = getDb();
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user) {
    logAudit(db, null, 'login_failed', req, { username, reason: 'no_user' });
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    logAudit(db, user.id, 'login_failed', req, { reason: 'bad_password' });
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const familyId = uuidv4();
  const ua = uaHash(req);
  const accessToken = issueAccessToken(user);
  const refreshToken = issueRefreshToken(db, user, familyId, ua);
  logAudit(db, user.id, 'login', req, { family_id: familyId });
  return res.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: ACCESS_TTL_SECONDS,
    user: { username: user.username, role: user.role, name: user.name, client_id: user.client_id }
  });
});

// POST /api/auth/refresh
router.post('/refresh', validateBody(refreshSchema), (req, res) => {
  const db = getDb();
  const { refresh_token } = req.body;
  let payload;
  try {
    payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ error: 'invalid_refresh' });
  }
  const tokenRow = db.prepare('SELECT * FROM refresh_tokens WHERE token_id = ?').get(payload.jti);
  if (!tokenRow) {
    return res.status(401).json({ error: 'unknown_token' });
  }
  if (tokenRow.revoked_at) {
    // Replay attempt: revoke the entire family.
    db.prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE family_id = ? AND revoked_at IS NULL`)
      .run(tokenRow.family_id);
    logAudit(db, tokenRow.user_id, 'refresh_replay_family_revoked', req, { family_id: tokenRow.family_id });
    return res.status(401).json({ error: 'family_revoked' });
  }
  if (new Date(tokenRow.expires_at) < new Date()) {
    return res.status(401).json({ error: 'refresh_expired' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(tokenRow.user_id);
  if (!user) {
    return res.status(401).json({ error: 'user_inactive' });
  }
  // Rotate: revoke old, issue new in same family.
  const newToken = issueRefreshToken(db, user, tokenRow.family_id, uaHash(req));
  db.prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now'), replaced_by = (
    SELECT token_id FROM refresh_tokens WHERE family_id = ? AND revoked_at IS NULL ORDER BY rowid DESC LIMIT 1
  ) WHERE token_id = ?`).run(tokenRow.family_id, payload.jti);
  const accessToken = issueAccessToken(user);
  logAudit(db, user.id, 'refresh', req, { family_id: tokenRow.family_id });
  return res.json({
    access_token: accessToken,
    refresh_token: newToken,
    expires_in: ACCESS_TTL_SECONDS
  });
});

// POST /api/auth/logout
router.post('/logout', requireAuth(), (req, res) => {
  const db = getDb();
  // Optional refresh token in body for full revoke; access token alone just stops being used.
  const refresh_token = req.body && req.body.refresh_token;
  if (refresh_token) {
    try {
      const payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
      db.prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE family_id = ? AND revoked_at IS NULL`)
        .run(payload.fam);
    } catch (_) { /* ignore - access-token logout still proceeds */ }
  }
  logAudit(db, req.user.id, 'logout', req, null);
  return res.json({ ok: true });
});

module.exports = router;
