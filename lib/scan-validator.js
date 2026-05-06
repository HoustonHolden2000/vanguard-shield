// lib/scan-validator.js
// PASS/FAIL rule engine for scan records. Minimal v1.1 logic — extend as
// real-world rule requirements emerge from pilot deployments.

function validateDriverLicense(decoded) {
  // decoded is the parsed PDF417 payload object. Minimum sanity checks.
  if (!decoded || typeof decoded !== 'object') {
    return { result: 'FAIL', reason: 'unparseable_payload' };
  }
  if (!decoded.dl_number && !decoded.licenseNumber && !decoded.id_number) {
    return { result: 'FAIL', reason: 'no_license_number' };
  }
  if (decoded.expiry_date) {
    const exp = Date.parse(decoded.expiry_date);
    if (!isNaN(exp) && exp < Date.now()) {
      return { result: 'FAIL', reason: 'expired_license' };
    }
  }
  return { result: 'PASS', reason: null };
}

function validateBillOfLading(decoded, scanType) {
  // For barcoded BoL or manual BoL: minimum is a non-empty BoL number.
  if (!decoded || typeof decoded !== 'object') {
    return { result: 'FAIL', reason: 'unparseable_payload' };
  }
  const bol = decoded.bol_number || decoded.bill_of_lading || decoded.shipment_number;
  if (!bol || String(bol).trim().length < 4) {
    return { result: 'FAIL', reason: 'no_bol_number' };
  }
  if (scanType === 'bill_of_lading_manual' && !decoded.carrier) {
    return { result: 'PARTIAL', reason: 'manual_entry_no_carrier' };
  }
  return { result: 'PASS', reason: null };
}

function validate(scanType, decoded) {
  switch (scanType) {
    case 'driver_license':
      return validateDriverLicense(decoded);
    case 'bill_of_lading':
    case 'bill_of_lading_manual':
      return validateBillOfLading(decoded, scanType);
    default:
      return { result: 'FAIL', reason: 'unknown_scan_type' };
  }
}

module.exports = { validate, validateDriverLicense, validateBillOfLading };
