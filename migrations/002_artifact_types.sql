-- Migration: Expand artifact types and add metadata column
-- This migration adds support for markdown, code, html, svg, mermaid, chart, and react artifact types.

-- 1. Drop the old CHECK constraint on type
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_type_check;

-- 2. Add new CHECK constraint with all supported types
ALTER TABLE artifacts ADD CONSTRAINT artifacts_type_check 
  CHECK (type IN ('checklist', 'note', 'markdown', 'code', 'html', 'react', 'svg', 'mermaid', 'chart'));

-- 3. Add metadata JSONB column for language, dataBindings, chartData
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Note: metadata stores:
--   { language: "python", dataBindings: { tool: "...", params: {...} }, chartData: [...] }
