-- Migration: PR H — Tracker Metric Definition Standard
-- Adds a metric_definition JSONB column to the trackers table so every
-- tracker can declare its canonical metric metadata (unit, dataType,
-- aggregation, cadence, direction, targets, trendWindow, relatedTo).
--
-- The column is nullable so existing trackers continue to work; the client
-- falls back to category defaults at read time via getDefaultMetricDefinition.
--
-- IDEMPOTENT: safe to re-run.

ALTER TABLE trackers
  ADD COLUMN IF NOT EXISTS metric_definition JSONB;

-- Lightweight index for future filtering by data type / direction.
CREATE INDEX IF NOT EXISTS trackers_metric_definition_data_type_idx
  ON trackers ((metric_definition->>'dataType'));
