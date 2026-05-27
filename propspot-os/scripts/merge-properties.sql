-- merge-properties.sql
-- Merges 452 Loring Dr (discard/prospect) INTO 451 Loring dr (keep/renovating)
-- Run via:  railway connect Postgres < scripts/merge-properties.sql

DO $$
DECLARE
  v_keep    uuid;
  v_discard uuid;
BEGIN

  -- Find the KEEP property (451 Loring, renovating)
  SELECT id INTO v_keep
    FROM properties
   WHERE address_line1 ILIKE '%451 Loring%'
   LIMIT 1;

  -- Find the DISCARD property (452 Loring, prospect)
  SELECT id INTO v_discard
    FROM properties
   WHERE address_line1 ILIKE '%452 Loring%'
   LIMIT 1;

  IF v_keep IS NULL THEN
    RAISE EXCEPTION 'KEEP property (451 Loring) not found';
  END IF;

  IF v_discard IS NULL THEN
    RAISE EXCEPTION 'DISCARD property (452 Loring) not found';
  END IF;

  IF v_keep = v_discard THEN
    RAISE EXCEPTION 'Both arguments resolve to the same property (%)!', v_keep;
  END IF;

  RAISE NOTICE 'KEEP    = %', v_keep;
  RAISE NOTICE 'DISCARD = %', v_discard;

  -- ── Simple re-assignments ─────────────────────────────────────────
  UPDATE calendar_events       SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE property_files        SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE prospects             SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE leads                 SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE opportunities         SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE purchases             SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE projects              SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE holdings_items        SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE holdings_payments     SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE holdings_documents    SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE folders               SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE photos                SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE share_links           SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE work_orders           SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE lawn_mow_events       SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE inbox_threads         SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE inbox_attachment_saves SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE uw_deals              SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE uw_audit_log          SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE tasks                 SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE drive_folders         SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE drive_files           SET property_id = v_keep WHERE property_id = v_discard;
  UPDATE inkd_envelopes        SET property_id = v_keep WHERE property_id = v_discard;

  -- ── activity (entity_id, not property_id) ─────────────────────────
  UPDATE activity
     SET entity_id = v_keep
   WHERE entity_type = 'property' AND entity_id = v_discard;

  -- ── property_contacts — PK (property_id, contact_id, role) ────────
  INSERT INTO property_contacts (property_id, contact_id, role, created_at)
    SELECT v_keep, contact_id, role, created_at
      FROM property_contacts WHERE property_id = v_discard
    ON CONFLICT DO NOTHING;
  DELETE FROM property_contacts WHERE property_id = v_discard;

  -- ── property_access — UNIQUE (property_id, user_id) ───────────────
  INSERT INTO property_access (property_id, user_id, granted_by, created_at)
    SELECT v_keep, user_id, granted_by, created_at
      FROM property_access WHERE property_id = v_discard
    ON CONFLICT DO NOTHING;
  DELETE FROM property_access WHERE property_id = v_discard;

  -- ── lawn_maintenance — property_id IS the primary key ─────────────
  IF EXISTS (SELECT 1 FROM lawn_maintenance WHERE property_id = v_discard) THEN
    IF NOT EXISTS (SELECT 1 FROM lawn_maintenance WHERE property_id = v_keep) THEN
      UPDATE lawn_maintenance SET property_id = v_keep WHERE property_id = v_discard;
      RAISE NOTICE 'lawn_maintenance: moved';
    ELSE
      DELETE FROM lawn_maintenance WHERE property_id = v_discard;
      RAISE NOTICE 'lawn_maintenance: discard row dropped (keep already has one)';
    END IF;
  END IF;

  -- ── pinned_properties / recent_properties — PK (user_id, property_id) ──
  INSERT INTO pinned_properties (user_id, property_id)
    SELECT user_id, v_keep FROM pinned_properties WHERE property_id = v_discard
    ON CONFLICT DO NOTHING;
  DELETE FROM pinned_properties WHERE property_id = v_discard;

  INSERT INTO recent_properties (user_id, property_id)
    SELECT user_id, v_keep FROM recent_properties WHERE property_id = v_discard
    ON CONFLICT DO NOTHING;
  DELETE FROM recent_properties WHERE property_id = v_discard;

  -- ── Delete the discard property ───────────────────────────────────
  DELETE FROM properties WHERE id = v_discard;

  RAISE NOTICE '✓ Merge complete. % deleted. All data now under %.', v_discard, v_keep;

END $$;
