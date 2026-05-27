-- ──────────────────────────────────────────────────────────────────
-- One-off: Reassign May 25 misfiled photos to 201 Sandhurst Road
-- ──────────────────────────────────────────────────────────────────
-- Task: "fix photo upload issues from 5/25" (Jordan Shutts · May 25)
-- "for some reasons these properties uploded under the wrong address.
--  need to be under 201 sandhurst"
--
-- Investigation: all 12 May 25 photos across the four surfaced
-- properties were uploaded by Jonathan Baghdady in one shooting
-- session. 2 photos were tagged 201 Sandhurst (probably correct);
-- 7 went to 933 Rawl Rd and 3 to 911 Rollingwood Trail in a tight
-- 38-second burst — clearly a property-selector slip during upload.
--
-- Fix: move the 10 misfiled photos to 201 Sandhurst.
-- ──────────────────────────────────────────────────────────────────

BEGIN;

UPDATE photos
   SET property_id = '266fba03-a5a1-4ac7-aa39-de6c6acf790d'  -- 201 Sandhurst Road
 WHERE deleted_at IS NULL
   AND uploaded_by = (SELECT id FROM users WHERE full_name = 'Jonathan Baghdady')
   AND created_at >= '2026-05-25' AND created_at < '2026-05-26'
   AND property_id IN (
     '155b2094-2991-4a53-a60a-31b3eab584ae',  -- 933 Rawl Rd
     'a0ffc865-f003-4de5-980c-61e24cfac7aa'   -- 911 Rollingwood Trail
   );

COMMIT;
