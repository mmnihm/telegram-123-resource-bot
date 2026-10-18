"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizePickupCode,
  isValidCustomCode,
  isValidPickupCode,
  generatePickupCode
} = require("../pickup-code");

test("keeps legacy six-digit numeric pickup codes valid", () => {
  assert.equal(isValidPickupCode("583021"), true);
  assert.equal(isValidPickupCode("000001"), true);
});

test("normalizes custom codes without case sensitivity", () => {
  assert.equal(normalizePickupCode("  movie_2026 "), "MOVIE_2026");
  assert.equal(isValidPickupCode("movie_2026"), true);
  assert.equal(isValidCustomCode("File-2026"), true);
});

test("rejects invalid custom code characters and lengths", () => {
  for (const value of ["abc", "contains space", "slash/name", "x".repeat(33), "", null]) {
    assert.equal(isValidPickupCode(value), false, String(value));
  }
});

test("generates a six-digit code and avoids existing codes", () => {
  const existing = new Set(["123456"]);
  let calls = 0;
  const fakeDb = {
    prepare() {
      return {
        get(code) {
          calls++;
          return existing.has(code) ? { code } : undefined;
        }
      };
    }
  };
  const code = generatePickupCode(fakeDb);
  assert.match(code, /^\d{6}$/);
  assert.ok(calls >= 1);
});
