// lib/audit-chain.js
// Tamper-evident chained-hash logic for scan records.
// Note: "tamper-evident" not "immutable" - chain protects against silent
// single-record mutation, NOT against full-DB rewrite by a malicious operator.

const crypto = require('crypto');

function computeRecordHash(prevChainHash, record) {
  // Canonical serialization for deterministic hashing across machines.
  const canonical = JSON.stringify({
    prev: prevChainHash || '',
    id: record.id,
    guard_id: record.guard_id,
    site_id: record.site_id,
    scan_type: record.scan_type,
    payload_hash: record.payload_hash,
    identifier_short: record.identifier_short || '',
    result: record.result,
    timestamp: record.timestamp
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function getLastChainHash(db) {
  const row = db.prepare('SELECT this_chain_hash FROM scans ORDER BY rowid DESC LIMIT 1').get();
  return row ? row.this_chain_hash : null;
}

function appendScan(db, scanRecord) {
  // Mutates scanRecord to add prev_chain_hash and this_chain_hash, then inserts.
  const prev = getLastChainHash(db);
  scanRecord.prev_chain_hash = prev;
  scanRecord.this_chain_hash = computeRecordHash(prev, scanRecord);

  db.prepare(`
    INSERT INTO scans
      (id, guard_id, site_id, scan_type, payload_hash, identifier_short,
       result, reason, gps_lat, gps_lon, photo_hash, metadata_json,
       timestamp, prev_chain_hash, this_chain_hash)
    VALUES
      (@id, @guard_id, @site_id, @scan_type, @payload_hash, @identifier_short,
       @result, @reason, @gps_lat, @gps_lon, @photo_hash, @metadata_json,
       @timestamp, @prev_chain_hash, @this_chain_hash)
  `).run(scanRecord);

  return scanRecord;
}

function verifyChain(db) {
  // Walks the chain from beginning, recomputes every hash. Returns
  // { ok: true } if chain integrity holds, or { ok: false, brokenAt: <id>,
  // expectedHash, actualHash } if a break is found.
  const rows = db.prepare('SELECT * FROM scans ORDER BY rowid ASC').all();
  let prev = null;
  for (const row of rows) {
    const expected = computeRecordHash(prev, row);
    if (expected !== row.this_chain_hash) {
      return {
        ok: false,
        broken_at: row.id,
        expected_hash: expected,
        actual_hash: row.this_chain_hash,
        prev_in_record: row.prev_chain_hash,
        prev_walked: prev
      };
    }
    prev = row.this_chain_hash;
  }
  return { ok: true, total_records: rows.length, last_hash: prev };
}

function payloadHash(payloadString) {
  return crypto.createHash('sha256').update(payloadString).digest('hex');
}

module.exports = { computeRecordHash, getLastChainHash, appendScan, verifyChain, payloadHash };
