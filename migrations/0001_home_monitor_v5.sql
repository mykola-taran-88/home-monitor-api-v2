-- Additive v5 structures. Apply to a backed-up preview D1 before deploying v5 code.
-- Notification/settings tables are also created here so a fresh D1 can accept
-- this migration before either Worker has handled its first request.
CREATE TABLE IF NOT EXISTS settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT
);
CREATE TABLE IF NOT EXISTS notification_settings (
  category_key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  mode TEXT,
  schedule_time TEXT,
  weekday INTEGER,
  monthday INTEGER,
  cooldown INTEGER NOT NULL DEFAULT 60
);
CREATE TABLE IF NOT EXISTS notification_channel_categories (
  chat_id TEXT NOT NULL,
  category_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(chat_id,category_key)
);

CREATE TABLE IF NOT EXISTS scheduled_jobs_state (
  job_key TEXT PRIMARY KEY,
  last_due_at TEXT,
  last_started_at TEXT,
  last_success_at TEXT,
  last_status TEXT,
  last_error TEXT,
  lock_until TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_lock ON scheduled_jobs_state(lock_until);

CREATE TABLE IF NOT EXISTS house_sleep_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sleep_date TEXT NOT NULL UNIQUE,
  window_start_utc TEXT NOT NULL,
  window_end_utc TEXT NOT NULL,
  score INTEGER,
  confidence INTEGER NOT NULL DEFAULT 0,
  components_json TEXT NOT NULL DEFAULT '{}',
  reasons_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_house_sleep_created ON house_sleep_scores(created_at);

CREATE TABLE IF NOT EXISTS climate_anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anomaly_key TEXT NOT NULL,
  device_id TEXT NOT NULL,
  anomaly_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pending_since TEXT,
  opened_at TEXT,
  recovered_since TEXT,
  resolved_at TEXT,
  first_value REAL,
  last_value REAL,
  delta REAL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  coverage REAL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_climate_anomalies_status ON climate_anomalies(status, device_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_climate_anomaly_active ON climate_anomalies(anomaly_key) WHERE status IN ('pending','active','recovering');

CREATE TABLE IF NOT EXISTS event_buffer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_key TEXT NOT NULL,
  category_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT NOT NULL DEFAULT '{}',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  flush_after TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_buffer_pending_group ON event_buffer(group_key) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_event_buffer_flush ON event_buffer(status, flush_after);

CREATE TABLE IF NOT EXISTS caretaker_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  facts_json TEXT NOT NULL,
  output_text TEXT NOT NULL,
  fallback_used INTEGER NOT NULL DEFAULT 1,
  output_length INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_caretaker_runs_created ON caretaker_runs(created_at);

CREATE TABLE IF NOT EXISTS recommendation_lifecycle (
  recommendation_key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_notified_at TEXT,
  snooze_until TEXT,
  resolved_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_recommendation_lifecycle_active ON recommendation_lifecycle(active, last_seen_at);

CREATE TABLE IF NOT EXISTS recommendation_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recommendation_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_recommendation_feedback_key ON recommendation_feedback(recommendation_key, created_at);

CREATE TABLE IF NOT EXISTS hm_v5_schema (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO hm_v5_schema(version) VALUES(1);

-- These category keys are retired by the v5 product model. Export settings and channel overrides first.
DELETE FROM notification_channel_categories WHERE category_key IN ('rain_window','home_score','ventilation');
DELETE FROM notification_settings WHERE category_key IN ('rain_window','home_score','ventilation');

INSERT INTO settings(setting_key, setting_value) VALUES
  ('climate_temp_delta_30m_c','3.0'),
  ('climate_humidity_delta_30m_pct','20'),
  ('climate_high_humidity_pct','75'),
  ('climate_low_humidity_pct','25'),
  ('condensation_margin_c','2.0'),
  ('bill_change_pct','10'),
  ('bill_change_uah','50'),
  ('high_priority_reminder_hours','24'),
  ('sleep_start','22:00'),
  ('sleep_end','07:00'),
  ('event_group_window_min','5'),
  ('smart_digest_max_items','3'),
  ('climate_expected_interval_min','5')
ON CONFLICT(setting_key) DO NOTHING;
