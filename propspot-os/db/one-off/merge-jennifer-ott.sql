-- ──────────────────────────────────────────────────────────────────
-- One-off: Merge Jennifer Ott's duplicate accounts
-- ──────────────────────────────────────────────────────────────────
-- Both rows had real data, so a simple rename wouldn't work.
-- Strategy: keep f20add56 (jott@rentdwella.com / "Jennifer Ott") and
-- migrate Jenn Ott's (d9b2480d / jenngunnels@gmail.com) FK references
-- over, then delete her row.
--
-- FK columns with non-zero rows for Jenn (verified via information_schema
-- scan): photos.uploaded_by (41), activity.actor_user_id (1). All other
-- 70 FK columns referencing users(id) were empty for her.
-- ──────────────────────────────────────────────────────────────────

BEGIN;

UPDATE photos
   SET uploaded_by = 'f20add56-cb3b-4c58-83b4-2f101a6cf10e'
 WHERE uploaded_by = 'd9b2480d-29d3-413c-8f05-f26e0b78d685';

UPDATE activity
   SET actor_user_id = 'f20add56-cb3b-4c58-83b4-2f101a6cf10e'
 WHERE actor_user_id = 'd9b2480d-29d3-413c-8f05-f26e0b78d685';

DELETE FROM users
 WHERE id = 'd9b2480d-29d3-413c-8f05-f26e0b78d685';

COMMIT;
