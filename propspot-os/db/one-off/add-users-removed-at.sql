-- ──────────────────────────────────────────────────────────────────
-- Add users.removed_at — soft-delete flag for the Members page
-- ──────────────────────────────────────────────────────────────────
-- Lets owners remove an active workspace member without destroying
-- their FK-attached data (comments, tasks, work_orders etc. would
-- otherwise cascade or get nulled). Removal nulls app_grants and
-- sets removed_at; login + the members list both filter on it.
-- Idempotent.
-- ──────────────────────────────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS users_removed_at_idx
  ON users (removed_at) WHERE removed_at IS NOT NULL;
