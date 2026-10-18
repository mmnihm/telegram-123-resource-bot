"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const {
  normalizePickupCode,
  isValidCustomCode,
  isValidPickupCode,
  generatePickupCode
} = require("./pickup-code");

test("normalizes custom codes and accepts safe formats", () => {
  assert.equal(normalizePickupCode("  movie_2026 "), "MOVIE_2026");
  assert.equal(isValidCustomCode("MOVIE_2026"), true);
  assert.equal(isValidCustomCode("AB-12"), true);
  assert.equal(isValidCustomCode("ABC"), false);
  assert.equal(isValidCustomCode("A B C D"), false);
  assert.equal(isValidCustomCode("中文取件码"), false);
  assert.equal(isValidCustomCode("A".repeat(33)), false);
});

test("accepts six-digit codes and valid custom codes", () => {
  assert.equal(isValidPickupCode("583021"), true);
  assert.equal(isValidPickupCode("movie_2026"), true);
  assert.equal(isValidPickupCode("123"), false);
  assert.equal(isValidPickupCode("bad code"), false);
});

test("existing SQLite schema keeps old records and accepts custom code", () => {
  const db = new Database(":memory:");
  db.exec(
    "PRAGMA foreign_keys=ON;" +
    "CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);" +
    "CREATE TABLE batches(code TEXT PRIMARY KEY,owner_id TEXT NOT NULL,file_count INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));" +
    "CREATE TABLE files(id INTEGER PRIMARY KEY AUTOINCREMENT,code TEXT NOT NULL,channel_message_id INTEGER NOT NULL,file_name TEXT NOT NULL DEFAULT 'Telegram 文件',file_size INTEGER NOT NULL DEFAULT 0,media_type TEXT NOT NULL DEFAULT 'file',FOREIGN KEY(code) REFERENCES batches(code));"
  );
  db.prepare("INSERT INTO batches(code,owner_id,file_count) VALUES(?,?,?)").run("583021", "1", 1);
  db.prepare("INSERT INTO files(code,channel_message_id) VALUES(?,?)").run("583021", 77);
  db.prepare("INSERT INTO batches(code,owner_id,file_count) VALUES(?,?,?)").run("MOVIE_2026", "1", 1);
  db.prepare("INSERT INTO files(code,channel_message_id) VALUES(?,?)").run("MOVIE_2026", 88);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM batches").get().n, 2);
  assert.equal(db.prepare("SELECT channel_message_id FROM files WHERE code=?").get("583021").channel_message_id, 77);
  assert.equal(db.prepare("SELECT channel_message_id FROM files WHERE code=?").get("MOVIE_2026").channel_message_id, 88);
  db.close();
});

test("automatic six-digit codes avoid existing codes", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE batches(code TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO batches(code) VALUES(?)").run("100000");
  const code = generatePickupCode(db);
  assert.match(code, /^\d{6}$/);
  assert.equal(db.prepare("SELECT 1 FROM batches WHERE code=?").get(code), undefined);
  db.close();
});
