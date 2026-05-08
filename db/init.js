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

function bootstrapDefaultSite(db) {
  const existingSite = db.prepare('SELECT id FROM sites WHERE id = ?').get('demo_site');
  if (!existingSite) {
    db.prepare('INSERT INTO sites (id, client_id, name) VALUES (?, ?, ?)').run('demo_site', 'vanguard', 'Demo Site (default)');
    console.log('[init-db] default site bootstrapped: demo_site (client=vanguard)');
  }
  const guardUser = process.env.GUARD_BOOTSTRAP_USERNAME;
  const guardPass = process.env.GUARD_BOOTSTRAP_PASSWORD;
  if (guardUser && guardPass) {
    const existingGuard = db.prepare('SELECT id FROM users WHERE username = ?').get(guardUser);
    if (!existingGuard) {
      const hash = bcrypt.hashSync(guardPass, 12);
      db.prepare('INSERT INTO users (username, password_hash, role, name, active) VALUES (?, ?, ?, ?, 1)')
        .run(guardUser, hash, 'guard', 'Guard (bootstrap)');
      console.log('[init-db] guard user bootstrapped:', guardUser);
    }
  }
}

function bootstrapTeamUsers(db) {
  // v4.4: UPSERT named admin accounts so credentials always match canonical values.
  // If user exists, update password to canonical bootstrap value. If not, insert.
  // Brad-ratified 2026-05-08 to onboard Brad/Matt/Chris into Vanguard Shield.
  const teamUsers = [
    { username: 'admin', password: 'vanguard123', role: 'admin', name: 'Brad Pate' },
    { username: 'Matt',  password: 'Vanguard123', role: 'admin', name: 'Matthew Lambert' },
    { username: 'Chris', password: 'Vanguard123', role: 'admin', name: 'Chris Pelt' }
  ];
  for (const u of teamUsers) {
    const hash = bcrypt.hashSync(u.password, 12);
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
    if (existing) {
      db.prepare(
        'UPDATE users SET password_hash = ?, role = ?, name = ?, active = 1 WHERE username = ?'
      ).run(hash, u.role, u.name, u.username);
      console.log('[init-db] team user updated: ' + u.username + ' (role=' + u.role + ')');
    } else {
      db.prepare(
        'INSERT INTO users (username, password_hash, role, name, active) VALUES (?, ?, ?, ?, 1)'
      ).run(u.username, hash, u.role, u.name);
      console.log('[init-db] team user bootstrapped: ' + u.username + ' (role=' + u.role + ')');
    }
  }
}

function initialize() {
  ensureDataDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  bootstrapAdmin(db);
  bootstrapDefaultSite(db);
  bootstrapTeamUsers(db);
  db.close();
  console.log('[init-db] complete:', DB_PATH);
}

if (require.main === module) {
  require('dotenv').config();
  initialize();
}

module.exports = { initialize, DB_PATH };
