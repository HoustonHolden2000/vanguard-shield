-- Iron Halo Verify v4.1 schema
-- SQLite, WAL mode required for concurrent reads during writes

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','guard','client')),
  client_id TEXT,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_client ON users(client_id);

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sites_client ON sites(client_id);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  guard_id INTEGER NOT NULL,
  site_id TEXT NOT NULL,
  scan_type TEXT NOT NULL CHECK(scan_type IN ('driver_license','bill_of_lading','bill_of_lading_manual')),
  payload_hash TEXT NOT NULL,
  identifier_short TEXT,
  result TEXT NOT NULL CHECK(result IN ('PASS','FAIL','PARTIAL')),
  reason TEXT,
  gps_lat REAL,
  gps_lon REAL,
  photo_hash TEXT,
  metadata_json TEXT,
  timestamp TEXT NOT NULL,
  prev_chain_hash TEXT,
  this_chain_hash TEXT NOT NULL,
  FOREIGN KEY (guard_id) REFERENCES users(id),
  FOREIGN KEY (site_id) REFERENCES sites(id)
);

CREATE INDEX IF NOT EXISTS idx_scans_site ON scans(site_id);
CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scans(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_scans_guard ON scans(guard_id);

-- Refresh tokens table for v1.1 JWT family-invalidation pattern
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  family_id TEXT NOT NULL,
  ua_hash TEXT,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  ip_address TEXT,
  ua_string TEXT,
  metadata_json TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
