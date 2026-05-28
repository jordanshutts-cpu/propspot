// ============================================================
//  Prop Spot — Sidebar badge counts (new-chrome Phase 2)
//  Single endpoint that returns every count the new sidebar
//  renders, so the frontend makes one round-trip on load.
//  Each count is independently fault-tolerant — if one query
//  errors (missing table, schema mismatch), that badge falls
//  back to null without breaking the others.
// ============================================================

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { scopedInboxIds } = require('../lib/inbox-scope');

const router = express.Router();
router.use(requireAuth);

// Resolve the caller's inbox scope so the inbox badge only counts threads
// in inboxes they can actually see. Returns null on failure so the count
// falls back to "unscoped" rather than 0 (better UX than a missing badge).
async function getInboxScopeIds(userId) {
  try {
    const { rows: u } = await query(`SELECT is_owner FROM users WHERE id = $1`, [userId]);
    if (!u[0]) return [];
    let scope;
    if (u[0].is_owner) {
      scope = { all: true };
    } else {
      const { rows } = await query(`
        SELECT ag.scope FROM app_grants ag JOIN apps a ON a.id = ag.app_id
         WHERE ag.user_id = $1 AND a.slug = 'inbox' LIMIT 1`, [userId]);
      scope = rows[0]?.scope || { inbox_ids: [] };
    }
    return await scopedInboxIds(scope, userId);
  } catch (err) {
    console.warn('sidebar-counts inbox scope resolution failed:', err.message);
    return null;
  }
}

// Run a counting query, return 0 on failure so the sidebar stays alive.
async function safeCount(sql, params = []) {
  try {
    const { rows } = await query(sql, params);
    return parseInt(rows[0]?.count ?? rows[0]?.n ?? 0, 10);
  } catch (err) {
    console.warn('sidebar-counts query failed:', err.message);
    return null;
  }
}

router.get('/', async (req, res) => {
  const me = req.userId;

  // Resolve inbox scope first so the badge query only counts inboxes the
  // caller can actually see. Without this the badge counts every open+
  // unread thread in the database — including unrouted threads and other
  // users' personal mailboxes — which inflates it by 10×+ for owners.
  const allowedInboxIds = await getInboxScopeIds(me);

  const [
    inbox, mentions, myTasks,
    prospects, leads, opportunities, acquisitions, projects, holdings, dispositions, sold,
    photosToday, workOrders, pulse, totalProperties
  ] = await Promise.all([
    // ── For You ───────────────────────────────────────────────
    // Open + unread threads in inboxes the caller can see, AND that are
    // either assigned to them or unassigned (work that's actually on
    // their plate, not someone else's).
    allowedInboxIds === null
      ? safeCount(`
          SELECT COUNT(*)::int AS count
            FROM inbox_threads
           WHERE status = 'open'
             AND unread = TRUE
             AND (assigned_to_user_id = $1 OR assigned_to_user_id IS NULL)
        `, [me])
      : allowedInboxIds.length === 0
        ? 0
        : safeCount(`
            SELECT COUNT(*)::int AS count
              FROM inbox_threads
             WHERE status = 'open'
               AND unread = TRUE
               AND shared_inbox_id = ANY($1::uuid[])
               AND (assigned_to_user_id = $2 OR assigned_to_user_id IS NULL)
          `, [allowedInboxIds, me]),

    // Unread mentions across pulse/inbox-thread + task + fieldcam.
    // "Read" = a row in user_mention_reads. We dedupe by (source, source_id).
    safeCount(`
      WITH all_mentions AS (
        SELECT 'pulse'::text AS source, m.id AS source_id
          FROM chat_mentions cm
          JOIN chat_messages m ON m.id = cm.message_id
         WHERE cm.mentioned_user_id = $1
        UNION
        SELECT 'task'::text, tc.id
          FROM task_mentions tm
          JOIN task_comments tc ON tc.id = tm.comment_id
         WHERE tm.mentioned_user_id = $1
        UNION
        SELECT 'fieldcam'::text, c.id
          FROM comments c
          JOIN users u ON u.id = $1
         WHERE u.full_name IS NOT NULL
           AND c.body ILIKE '%@' || u.full_name || '%'
           AND c.user_id <> $1
      )
      SELECT COUNT(*)::int AS count
        FROM all_mentions a
        LEFT JOIN user_mention_reads r
          ON r.user_id = $1 AND r.source = a.source AND r.source_id = a.source_id
       WHERE r.user_id IS NULL
    `, [me]),

    safeCount(`
      SELECT COUNT(*)::int AS count
        FROM tasks
       WHERE status IN ('open','in_progress')
         AND assigned_to = $1
    `, [me]),

    // ── Pipeline (Jordan's flow: prospect → lead → opportunity → acquisition
    //    → project → holdings | disposition → sold; dead off-track) ────
    safeCount(`SELECT COUNT(*)::int AS count FROM properties     WHERE status = 'prospect'`),
    safeCount(`SELECT COUNT(*)::int AS count FROM leads         WHERE status IN ('new','working')`),
    safeCount(`SELECT COUNT(*)::int AS count FROM opportunities WHERE status IN ('active','appointment_set')`),
    safeCount(`SELECT COUNT(*)::int AS count FROM properties    WHERE status = 'purchasing'`),                                              // acquisitions
    safeCount(`SELECT COUNT(*)::int AS count FROM properties    WHERE status = 'renovating'`),                                              // projects
    safeCount(`SELECT COUNT(*)::int AS count FROM properties    WHERE status IN ('renting','rented','listed_for_rent')`),                   // holdings (rentals only)
    safeCount(`SELECT COUNT(*)::int AS count FROM properties    WHERE status IN ('selling','listed_for_sale','under_contract_buyer')`),     // dispositions
    safeCount(`SELECT COUNT(*)::int AS count FROM properties    WHERE status IN ('sold','assigned')`),                                      // sold

    // ── Tools ─────────────────────────────────────────────────
    safeCount(`SELECT COUNT(*)::int AS count FROM photos WHERE created_at >= CURRENT_DATE AND deleted_at IS NULL`),
    safeCount(`SELECT COUNT(*)::int AS count FROM work_orders WHERE status IN ('open','scheduled','in_progress')`),

    // Pulse unread: channels where the latest message is newer than my last_read_at.
    safeCount(`
      SELECT COUNT(*)::int AS count
        FROM chat_channel_members ccm
        JOIN (
          SELECT channel_id, MAX(created_at) AS latest
            FROM chat_messages
           WHERE channel_id IS NOT NULL
           GROUP BY channel_id
        ) lm ON lm.channel_id = ccm.channel_id
       WHERE ccm.user_id = $1
         AND lm.latest > COALESCE(ccm.last_read_at, 'epoch'::timestamptz)
    `, [me]),

    // Total property count for the dashboard KPI card.
    safeCount(`SELECT COUNT(*)::int AS count FROM properties WHERE status != 'dropped'`)
  ]);

  res.json({
    inbox, mentions, myTasks,
    prospects, leads, opportunities, acquisitions, projects, holdings, dispositions, sold,
    photosToday, workOrders, pulse, totalProperties
  });
});

module.exports = router;
