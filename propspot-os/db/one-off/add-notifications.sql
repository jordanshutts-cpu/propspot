-- ──────────────────────────────────────────────────────────────────
-- Add notifications table  (Phase 4 — real-time notification feed)
-- ──────────────────────────────────────────────────────────────────
-- Stores per-user notification rows written by:
--   • task assignment (POST /api/tasks, PATCH /api/tasks/:id)
--   • task @mention   (POST /api/tasks/:id/comments)
--   • Pulse @mention  (POST /api/pulse/messages)
-- Each insert also fans out via hub.publish('user:<id>', …) to any
-- open SSE connection at /api/notifications/stream.
-- Idempotent.
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT        NOT NULL,   -- task_assigned | task_mention | pulse_mention
  title      TEXT        NOT NULL,
  body       TEXT,
  url        TEXT,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload    JSONB
);

CREATE INDEX IF NOT EXISTS notifications_user_recent_idx
  ON notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id)
  WHERE read_at IS NULL;
