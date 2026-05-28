-- Add prospect_status sub-column to properties.
-- Drives the Prospects kanban the same way acquisition_status / project_status do.
-- Idempotent — ADD COLUMN IF NOT EXISTS + ON CONFLICT DO NOTHING on constraint.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS prospect_status TEXT NOT NULL DEFAULT 'research';

-- Drop + recreate so we can update the allowed values safely.
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_prospect_status_check;
ALTER TABLE properties ADD CONSTRAINT properties_prospect_status_check
  CHECK (prospect_status IN ('research','outreach','follow_up','engaged'));

CREATE INDEX IF NOT EXISTS properties_prospect_status_idx
  ON properties(prospect_status) WHERE status = 'prospect';
