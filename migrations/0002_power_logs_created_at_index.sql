-- Speeds up period-bounded power statistics and predecessor-sample lookups.
-- Apply after the existing Home Monitor core schema has created power_logs.
CREATE INDEX IF NOT EXISTS idx_power_logs_created_at ON power_logs(created_at);
