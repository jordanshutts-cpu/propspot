#!/usr/bin/env python3
"""
merge-properties.py — Merges 452 Loring Dr (discard) INTO 451 Loring dr (keep).
Run via:  railway run python3 scripts/merge-properties.py
"""
import os, sys, pg8000.native

DATABASE_URL = os.environ.get('DATABASE_URL')
if not DATABASE_URL:
    print('❌ DATABASE_URL not set. Run via: railway run python3 scripts/merge-properties.py')
    sys.exit(1)

# Parse postgres://user:pass@host:port/db
from urllib.parse import urlparse
u = urlparse(DATABASE_URL)

conn = pg8000.native.Connection(
    host=u.hostname,
    port=u.port or 5432,
    database=u.path.lstrip('/'),
    user=u.username,
    password=u.password,
    ssl_context=True,
)

SIMPLE_TABLES = [
    'calendar_events','property_files','prospects','leads','opportunities',
    'purchases','projects','holdings_items','holdings_payments','holdings_documents',
    'folders','photos','share_links','work_orders','lawn_mow_events',
    'inbox_threads','inbox_attachment_saves','uw_deals','uw_audit_log','tasks',
    'drive_folders','drive_files','inkd_envelopes',
]

try:
    # Find the two properties
    rows = conn.run("SELECT id, address_line1, city, state, status FROM properties WHERE address_line1 ILIKE '%451 Loring%' LIMIT 1")
    if not rows:
        print('❌ KEEP property (451 Loring) not found'); sys.exit(1)
    keep_id, keep_addr, keep_city, keep_state, keep_status = rows[0]

    rows = conn.run("SELECT id, address_line1, city, state, status FROM properties WHERE address_line1 ILIKE '%452 Loring%' LIMIT 1")
    if not rows:
        print('❌ DISCARD property (452 Loring) not found'); sys.exit(1)
    discard_id, disc_addr, disc_city, disc_state, disc_status = rows[0]

    if keep_id == discard_id:
        print('❌ Both resolve to the same property'); sys.exit(1)

    print('\n📋 Merge plan')
    print('─' * 57)
    print(f'  KEEP    [{keep_id}]')
    print(f'          {keep_addr}, {keep_city}, {keep_state}  ({keep_status})')
    print(f'  DISCARD [{discard_id}]')
    print(f'          {disc_addr}, {disc_city}, {disc_state}  ({disc_status})')
    print('─' * 57 + '\n')

    conn.run('BEGIN')

    # Simple re-assignments
    for table in SIMPLE_TABLES:
        try:
            conn.run(f'UPDATE {table} SET property_id = :new WHERE property_id = :old',
                     new=keep_id, old=discard_id)
            n = conn.row_count
            if n > 0:
                print(f'  ✓ {table}: {n} row(s) moved')
        except pg8000.native.DatabaseError as e:
            if '42P01' in str(e):  # table not found
                print(f'  – {table}: table not found, skipping')
            else:
                raise

    # activity (entity_id)
    conn.run("UPDATE activity SET entity_id = :new WHERE entity_type = 'property' AND entity_id = :old",
             new=keep_id, old=discard_id)
    n = conn.row_count
    if n > 0: print(f'  ✓ activity: {n} row(s) moved')

    # property_contacts
    conn.run("""INSERT INTO property_contacts (property_id, contact_id, role, created_at)
                SELECT :new, contact_id, role, created_at FROM property_contacts WHERE property_id = :old
                ON CONFLICT DO NOTHING""", new=keep_id, old=discard_id)
    conn.run('DELETE FROM property_contacts WHERE property_id = :old', old=discard_id)
    if conn.row_count > 0: print('  ✓ property_contacts: merged')

    # property_access
    conn.run("""INSERT INTO property_access (property_id, user_id, granted_by, created_at)
                SELECT :new, user_id, granted_by, created_at FROM property_access WHERE property_id = :old
                ON CONFLICT DO NOTHING""", new=keep_id, old=discard_id)
    conn.run('DELETE FROM property_access WHERE property_id = :old', old=discard_id)
    if conn.row_count > 0: print('  ✓ property_access: merged')

    # lawn_maintenance (property_id is PK)
    lm_discard = conn.run('SELECT 1 FROM lawn_maintenance WHERE property_id = :id', id=discard_id)
    if lm_discard:
        lm_keep = conn.run('SELECT 1 FROM lawn_maintenance WHERE property_id = :id', id=keep_id)
        if not lm_keep:
            conn.run('UPDATE lawn_maintenance SET property_id = :new WHERE property_id = :old',
                     new=keep_id, old=discard_id)
            print('  ✓ lawn_maintenance: moved')
        else:
            conn.run('DELETE FROM lawn_maintenance WHERE property_id = :old', old=discard_id)
            print('  ✓ lawn_maintenance: discard row dropped (keep already has one)')

    # pinned_properties / recent_properties
    for table in ['pinned_properties', 'recent_properties']:
        conn.run(f"""INSERT INTO {table} (user_id, property_id)
                     SELECT user_id, :new FROM {table} WHERE property_id = :old
                     ON CONFLICT DO NOTHING""", new=keep_id, old=discard_id)
        conn.run(f'DELETE FROM {table} WHERE property_id = :old', old=discard_id)
        if conn.row_count > 0: print(f'  ✓ {table}: merged')

    # Delete the discard property
    conn.run('DELETE FROM properties WHERE id = :id', id=discard_id)

    conn.run('COMMIT')

    print('\n' + '─' * 57)
    print(f'🎉 Done!  {discard_id}')
    print(f'         ↳ all data now lives under {keep_id}')
    print('─' * 57 + '\n')

except Exception as e:
    try: conn.run('ROLLBACK')
    except: pass
    print(f'\n❌ Merge failed — database rolled back.')
    print(f'   Error: {e}')
    sys.exit(1)
finally:
    conn.close()
