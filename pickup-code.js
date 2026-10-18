"use strict";

function normalizePickupCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function isValidCustomCode(value) {
  const code = normalizePickupCode(value);
  return /^[A-Z0-9_-]{4,32}$/.test(code);
}

function isValidPickupCode(value) {
  const code = normalizePickupCode(value);
  return /^\d{6}$/.test(code) || isValidCustomCode(code);
}

function generatePickupCode(db) {
  let code;
  do {
    code = String(100000 + Math.floor(Math.random() * 900000));
  } while (db.prepare("SELECT 1 FROM batches WHERE code = ?").get(code));
  return code;
}

module.exports = {
  normalizePickupCode,
  isValidCustomCode,
  isValidPickupCode,
  generatePickupCode
};
