import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

test("v5 D1 migration is additive, repeatable, and retires only obsolete category settings", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE settings(setting_key TEXT PRIMARY KEY, setting_value TEXT);
    CREATE TABLE notification_settings(category_key TEXT PRIMARY KEY, enabled INTEGER DEFAULT 1, mode TEXT, schedule_time TEXT, weekday INTEGER, monthday INTEGER, cooldown INTEGER DEFAULT 60);
    CREATE TABLE notification_channel_categories(chat_id TEXT, category_key TEXT, enabled INTEGER DEFAULT 1, PRIMARY KEY(chat_id,category_key));
    CREATE TABLE recommendations(id INTEGER PRIMARY KEY, recommendation_key TEXT, status TEXT, resolved_at TEXT);
    INSERT INTO notification_settings(category_key) VALUES('rain_window'),('home_score'),('ventilation'),('ai_insights');
    INSERT INTO notification_channel_categories(chat_id,category_key) VALUES('chat','rain_window'),('chat','home_score'),('chat','ventilation'),('chat','ai_insights');
    INSERT INTO settings VALUES('day_tariff','4.32');
  `);
  const sql = readFileSync(new URL("../migrations/0001_home_monitor_v5.sql", import.meta.url), "utf8");
  db.exec(sql);
  db.exec(sql);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_settings WHERE category_key IN ('rain_window','home_score','ventilation')").get().n, 0);
  assert.equal(db.prepare("SELECT enabled FROM notification_settings WHERE category_key='ai_insights'").get().enabled, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_channel_categories WHERE category_key='ai_insights'").get().n, 1);
  assert.equal(db.prepare("SELECT setting_value FROM settings WHERE setting_key='day_tariff'").get().setting_value, "4.32");
  assert.equal(db.prepare("SELECT setting_value FROM settings WHERE setting_key='bill_change_pct'").get().setting_value, "10");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('scheduled_jobs_state','house_sleep_scores','climate_anomalies','event_buffer','caretaker_runs','recommendation_lifecycle')").get().n, 6);
  db.close();
});

test("v5 migration also applies to an empty D1 before Worker bootstrap", () => {
  const db = new DatabaseSync(":memory:"),
    sql = readFileSync(new URL("../migrations/0001_home_monitor_v5.sql", import.meta.url), "utf8");
  db.exec(sql);
  assert.equal(db.prepare("SELECT setting_value FROM settings WHERE setting_key='sleep_start'").get().setting_value,"22:00");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='event_buffer'").get().n,1);
  db.close();
});
