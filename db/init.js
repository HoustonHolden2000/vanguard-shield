// db/init.js
// Initialize SQLite database with schema. Bootstrap admin user from env vars.
// Idempotent: safe to run on every server start.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data2', 'shield.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('[init-db] created data dir:', dir);
  }
}

function applySchema(db) {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  console.log('[init-db] schema applied');
}

function bootstrapAdmin(db) {
  const username = process.env.ADMIN_BOOTSTRAP_USERNAME;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!username || !password) {
    console.log('[init-db] no ADMIN_BOOTSTRAP_USERNAME/PASSWORD set, skipping admin bootstrap');
    return;
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    console.log('[init-db] admin user already exists, no bootstrap needed');
    return;
  }
  const hash = bcrypt.hashSync(password, 12);
  db.prepare(
    'INSERT INTO users (username, password_hash, role, name, active) VALUES (?, ?, ?, ?, 1)'
  ).run(username, hash, 'admin', 'Admin (bootstrap)');
  console.log('[init-db] admin user bootstrapped:', username);
  console.log('[init-db] WARNING: change admin password via admin UI, then remove ADMIN_BOOTSTRAP_PASSWORD from env');
}

function initialize() {
  ensureDataDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  bootstrapAdmin(db);
  db.close();
  console.log('[init-db] complete:', DB_PATH);
}

if (require.main === module) {
  // Run from CLI: `npm run init-db`
  require('dotenv').config();
  initialize();
}

module.exports = { initialize, DB_PATH };
