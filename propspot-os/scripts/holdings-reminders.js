#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
//  holdings-reminders.js
//  Daily cron: scans holdings_items for upcoming due dates and pushes
//  a notification to every owner. Idempotent — re-running on the same
//  day won't duplicate notifications (deduped by item_id + due_date).
//
//  Wire it on Railway with a separate cron service:
//    railway run node scripts/holdings-reminders.js   (manual)
//    or set up a daily cron schedule via Railway dashboard.
// ─────────────────────────────────────────────────────────────────
require('dotenv').config();
const { query, pool } = require('../db');
const { pushNotification } = require('../lib/notify');

async function run() {
  console.log('[holdings-reminders] starting…');

  // Find every active holdings item whose next_due_date falls inside its
  // own reminder window (defaults if columns are null: 14 days for active).
  const { rows: dueItems } = await query(`
    SELECT i.id, i.property_id, i.item_type, i.label,
           i.next_due_date, i.reminder_days_before,
           p.address_line1
      FROM holdings_items i
      LEFT JOIN properties p ON p.id = i.property_id
     WHERE i.status = 'active'
       AND COALESCE(i.reminder_enabled, TRUE) = TRUE
       AND i.next_due_date IS NOT NULL
       AND i.next_due_date <= CURRENT_DATE + COALESCE(i.reminder_days_before, 14)
       AND i.next_due_date >= CURRENT_DATE
  `);

  if (!dueItems.length) {
    console.log('[holdings-reminders] nothing due — exiting.');
    await pool.end();
    return;
  }

  // Active workspace owners only.
  const { rows: owners } = await query(
    `SELECT id FROM users WHERE is_owner = TRUE AND removed_at IS NULL`
  );

  let pushed = 0;
  let skipped = 0;

  for (const item of dueItems) {
    const dueIso = new Date(item.next_due_date).toISOString().slice(0, 10);
    const daysOut = Math.ceil(
      (new Date(item.next_due_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    );
    const when = daysOut <= 0 ? 'due today' :
                 daysOut === 1 ? 'due tomorrow' :
                 `due in ${daysOut} days`;

    for (const o of owners) {
      // Dedupe: if a holdings_due notification already exists for this
      // (user, item, due_date), skip.
      const { rows: exists } = await query(`
        SELECT 1 FROM notifications
         WHERE user_id = $1
           AND type    = 'holdings_due'
           AND payload->>'item_id'  = $2
           AND payload->>'due_date' = $3
         LIMIT 1
      `, [o.id, item.id, dueIso]);
      if (exists.length) { skipped++; continue; }

      await pushNotification({
        userId: o.id, type: 'holdings_due',
        title: `${item.label || item.item_type || 'Holdings item'} ${when}`,
        body: item.address_line1 || 'Property holdings',
        url: '/holdings.html',
        payload: { item_id: item.id, due_date: dueIso, days_out: daysOut }
      });
      pushed++;
    }
  }

  console.log(`[holdings-reminders] done. pushed=${pushed} skipped=${skipped} items=${dueItems.length} owners=${owners.length}`);
  await pool.end();
}

run().catch(err => {
  console.error('[holdings-reminders] failed:', err);
  process.exit(1);
});
