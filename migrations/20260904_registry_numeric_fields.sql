-- D264 data repair: numeric registry fields (number / currency / percentage in
-- profile_type_definitions.field_schema) that the Create Profile dialog stored
-- as strings ("12500") become numbers. Only values that are plain numerals are
-- touched; anything else stays as typed. updated_at is left alone so open tabs
-- keep their versions.
WITH numeric_keys AS (
  SELECT DISTINCT f->>'key' AS key
  FROM profile_type_definitions d, jsonb_array_elements(d.field_schema) f
  WHERE f->>'type' IN ('number', 'currency', 'percentage')
),
targets AS (
  SELECT p.id, k.key, p.fields->>k.key AS raw
  FROM profiles p
  JOIN numeric_keys k ON p.fields ? k.key
  WHERE jsonb_typeof(p.fields->k.key) = 'string'
    AND (p.fields->>k.key) ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
),
patches AS (
  SELECT id, jsonb_object_agg(key, to_jsonb(trim(raw)::numeric)) AS patch
  FROM targets GROUP BY id
)
UPDATE profiles p SET fields = p.fields || patches.patch
FROM patches WHERE patches.id = p.id;
