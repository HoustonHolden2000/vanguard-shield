// db/connection.js
// Shared SQLite connection helper. Single Database instance per process,
// WAL mode for concurrent reads during writes.

const path = require('path');
const Database = require('better-sqlite3');

let _db = null;

function getDb() {
  if (_db) return _db;
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data2', 'shield.db');
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, closeDb };
