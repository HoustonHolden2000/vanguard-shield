// middleware/auth.js
// JWT verification middleware. Reads access token from Authorization header.

const jwt = require('jsonwebtoken');

function requireAuth(allowedRoles) {
  // Returns express middleware. allowedRoles is optional array (e.g. ['guard'], ['admin','client'])
  return (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: 'missing_token' });
    }
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      req.user = {
        id: payload.sub,
        username: payload.username,
        role: payload.role,
        client_id: payload.client_id || null,
        name: payload.name
      };
      if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ error: 'role_not_allowed' });
      }
      next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'token_expired' });
      }
      return res.status(401).json({ error: 'invalid_token' });
    }
  };
}

module.exports = { requireAuth };
