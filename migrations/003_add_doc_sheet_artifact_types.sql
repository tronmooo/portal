-- Migration: Allow 'doc' and 'sheet' artifact types
-- Wave 17: Univer sheets and rich-text doc editor were saving 500 because the
-- CHECK constraint on artifacts.type didn't permit these types. Expanded.

ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_type_check;

ALTER TABLE artifacts ADD CONSTRAINT artifacts_type_check
  CHECK (type IN ('checklist', 'note', 'markdown', 'code', 'html', 'react', 'svg', 'mermaid', 'chart', 'doc', 'sheet'));
