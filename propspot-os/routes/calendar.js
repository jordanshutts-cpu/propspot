const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const gcal = require('../lib/google-calendar');

const router = express.Router();
router.use(requireAuth);

// ── POST /api/calendar/google/connect ─────────────────────────────
// Kick off OAuth so the current user can grant calendar.events scope.
// Returns the Google consent URL the frontend redirects to. Callback
// lands at the existing /api/inbox/mailboxes/oauth/callback (same
// redirect URI we already registered) and is dispatched by `kind`.
router.post('/google/connect', async (req, res) => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = jwt.sign(
    { userId: req.userId, nonce, kind: 'personal-calendar' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
  res.json({ url: gcal.buildConsentUrl(state) });
});

// GET /api/calendar/google/status — { connected: bool, email?: string }
router.get('/google/status', async (req, res) => {
  const grant = await gcal.getUserGrant(req.userId);
  res.json({ connected: !!grant, email: grant?.email || null });
});

// DELETE /api/calendar/google — disconnect (clear stored refresh token)
router.delete('/google', async (req, res) => {
  await query(
    `UPDATE users
        SET google_calendar_refresh_encrypted = NULL,
            google_calendar_connected_at      = NULL
      WHERE id = $1`,
    [req.userId]
  );
  res.json({ ok: true });
});

// GET /api/calendar?month=2026-05&visibility=company
//   or  /api/calendar?from=2026-04-26&to=2026-06-07  (preferred for grid views)
router.get('/', async (req, res) => {
  try {
    const { month, from, to, visibility } = req.query;
    let start, end;
    if (from && to) {
      start = from;
      end = to;
    } else if (month) {
      start = month + '-01';
      const d = new Date(start);
      d.setMonth(d.getMonth() + 1);
      end = d.toISOString().split('T')[0];
    } else {
      const now = new Date();
      start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      end = next.toISOString().split('T')[0];
    }

    let sql = `
      SELECT e.*, u.full_name AS created_by_name, p.address_line1 AS property_address
        FROM calendar_events e
        LEFT JOIN users u ON u.id = e.created_by
        LEFT JOIN properties p ON p.id = e.property_id
       WHERE e.start_at >= $1 AND e.start_at < $2
    `;
    const params = [start, end];

    if (visibility === 'personal') {
      params.push(req.userId);
      sql += ` AND e.visibility = 'personal' AND e.created_by = $${params.length}`;
    } else {
      params.push(req.userId);
      sql += ` AND (e.visibility = 'company' OR (e.visibility = 'personal' AND e.created_by = $${params.length}))`;
    }

    sql += ` ORDER BY e.start_at`;
    const { rows } = await query(sql, params);

    // For Personal view, ALSO pull events from the caller's primary
    // Google Calendar (if connected) inside the same window. We mark
    // them source='google' so the UI can render them distinctly and
    // skip the kanban-style edit/delete actions (we'd need to write
    // back through the API for those, which is its own follow-up).
    let merged = rows;
    let googleWarning = null;
    let googleEventCount = null;
    if (visibility === 'personal') {
      try {
        const grant = await gcal.getUserGrant(req.userId);
        if (grant) {
          // Widen the window by one day on each side to catch events whose
          // local time crosses midnight UTC. Without this, an event scheduled
          // at 9 PM EDT on the last visible Saturday is at 01:00 UTC Sunday
          // and falls outside a strict UTC-midnight bound.
          const fromDate = new Date(start + 'T00:00:00Z');
          fromDate.setUTCDate(fromDate.getUTCDate() - 1);
          const toDate = new Date(end + 'T00:00:00Z');
          toDate.setUTCDate(toDate.getUTCDate() + 1);
          const gEvents = await gcal.listEvents(req.userId, fromDate.toISOString(), toDate.toISOString());
          googleEventCount = gEvents.length;
          const mapped = gEvents.map(g => ({
            id:            'gcal-' + g.id,
            google_event_id: g.id,
            title:         g.summary || '(no title)',
            description:   g.description || null,
            event_type:    'general',
            visibility:    'personal',
            start_at:      g.start?.dateTime || (g.start?.date ? g.start.date + 'T00:00:00Z' : null),
            end_at:        g.end?.dateTime   || (g.end?.date   ? g.end.date   + 'T00:00:00Z' : null),
            all_day:       !g.start?.dateTime,
            property_id:   null,
            created_by:    req.userId,
            created_by_name: 'Google Calendar',
            source:        'google',
            meet_url:      g.hangoutLink || g.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || null,
            html_link:     g.htmlLink || null
          }));
          // Dedupe — skip Google events we mirrored ourselves (we wrote
          // them with google_event_id so they're already in the DB rows).
          const mirroredIds = new Set(rows.map(r => r.google_event_id).filter(Boolean));
          const fresh = mapped.filter(g => !mirroredIds.has(g.google_event_id));
          merged = [...rows, ...fresh].sort((a, b) =>
            new Date(a.start_at) - new Date(b.start_at)
          );
        }
      } catch (gerr) {
        googleWarning = gerr.message || 'Google Calendar fetch failed';
        console.warn('Personal Google Calendar pull failed:', gerr.message);
        // Fall through — return what we have from the DB.
      }
    }

    res.json({
      events: merged,
      google_warning: googleWarning,
      google_event_count: googleEventCount
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load events' });
  }
});

// POST /api/calendar
//   body: { title, description, event_type, visibility, start_at, end_at,
//           all_day, property_id, create_meet }
// For personal events on a connected user we also write to Google Calendar.
// create_meet=true asks Google to generate a Meet link via conferenceData.
router.post('/', async (req, res) => {
  try {
    const { title, description, event_type, visibility, start_at, end_at, all_day, property_id, create_meet } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!start_at) return res.status(400).json({ error: 'Start date is required' });

    let googleEventId = null;
    let meetUrl = null;
    if (visibility === 'personal' && (create_meet || req.body.write_to_google)) {
      // Only attempt the round-trip if the user has actually connected.
      // We don't auto-write every personal event to Google — only when
      // the user opts in (Meet checkbox today; could become a default later).
      try {
        const inserted = await gcal.createEvent(req.userId, {
          summary: title.trim(),
          description: description || '',
          start: start_at,
          end:   end_at || start_at,
          allDay: !!all_day
        }, { createMeet: !!create_meet });
        googleEventId = inserted.googleEventId;
        meetUrl       = inserted.meetUrl;
      } catch (gerr) {
        // Surface the Google error so the UI can prompt to reconnect.
        return res.status(502).json({ error: 'Google Calendar write failed: ' + gerr.message });
      }
    }

    const mentionedIds = Array.isArray(req.body.mentioned_user_ids) && req.body.mentioned_user_ids.length
      ? req.body.mentioned_user_ids : null;

    const { rows: [event] } = await query(`
      INSERT INTO calendar_events (title, description, event_type, visibility, start_at, end_at, all_day, property_id, created_by, google_event_id, meet_url, mentioned_user_ids)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `, [
      title.trim(),
      description || null,
      event_type || 'general',
      visibility || 'company',
      start_at,
      end_at || null,
      all_day || false,
      property_id || null,
      req.userId,
      googleEventId,
      meetUrl,
      mentionedIds
    ]);

    // Fire-and-forget mention emails. Skip self-mentions.
    if (mentionedIds && mentionedIds.length) {
      const fresh = mentionedIds.filter(uid => uid !== req.userId);
      if (fresh.length) {
        notifyCalendarMentions(event.id, fresh, req.userId).catch(e =>
          console.error('Calendar mention notify failed:', e));
      }
    }

    res.status(201).json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// PATCH /api/calendar/:id
router.patch('/:id', async (req, res) => {
  try {
    const { title, description, event_type, start_at, end_at, all_day, property_id } = req.body;

    // Read prior mentions so we can email only the NEW ones (don't spam
    // an already-mentioned user just because the title changed).
    const { rows: priorRows } = await query(
      `SELECT mentioned_user_ids FROM calendar_events WHERE id = $1`, [req.params.id]
    );
    const prior = new Set(priorRows[0]?.mentioned_user_ids || []);
    const nextMentioned = req.body.mentioned_user_ids !== undefined
      ? (Array.isArray(req.body.mentioned_user_ids) && req.body.mentioned_user_ids.length
          ? req.body.mentioned_user_ids : null)
      : undefined; // not provided → don't touch column

    const { rows: [event] } = await query(`
      UPDATE calendar_events SET
        title = COALESCE($2, title),
        description = COALESCE($3, description),
        event_type = COALESCE($4, event_type),
        start_at = COALESCE($5, start_at),
        end_at = $6,
        all_day = COALESCE($7, all_day),
        property_id = $8,
        mentioned_user_ids = CASE WHEN $9::boolean THEN $10::uuid[] ELSE mentioned_user_ids END
      WHERE id = $1 RETURNING *
    `, [
      req.params.id, title || null,
      description !== undefined ? description : null,
      event_type || null, start_at || null,
      end_at !== undefined ? end_at : null,
      all_day !== undefined ? all_day : null,
      property_id !== undefined ? property_id : null,
      nextMentioned !== undefined,
      nextMentioned || null
    ]);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Fire-and-forget — email only mentions that are NEW since last save.
    if (Array.isArray(event.mentioned_user_ids) && event.mentioned_user_ids.length) {
      const fresh = event.mentioned_user_ids
        .filter(uid => uid !== req.userId && !prior.has(uid));
      if (fresh.length) {
        notifyCalendarMentions(event.id, fresh, req.userId).catch(e =>
          console.error('Calendar mention notify failed:', e));
      }
    }

    res.json(event);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// DELETE /api/calendar/:id
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await query(`DELETE FROM calendar_events WHERE id = $1 AND created_by = $2`, [req.params.id, req.userId]);
    if (!rowCount) {
      await query(`DELETE FROM calendar_events WHERE id = $1`, [req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ── Mention notifications ────────────────────────────────────────
// Email each newly-mentioned user. Failures are logged but never throw
// back to the user — the event save already committed.
const { sendCalendarMentionEmail } = require('../lib/email');

async function notifyCalendarMentions(eventId, userIds, inviterId) {
  const { rows } = await query(`
    SELECT u.id, u.email, u.full_name AS recipient_name,
           inv.full_name AS inviter_name,
           e.title, e.start_at, e.end_at, e.all_day,
           p.address_line1, p.city, p.state
      FROM users u
      JOIN calendar_events e ON e.id = $1
      JOIN users inv ON inv.id = $3
      LEFT JOIN properties p ON p.id = e.property_id
     WHERE u.id = ANY($2::uuid[])
  `, [eventId, userIds, inviterId]);
  if (!rows.length) return;

  const e = rows[0]; // event fields are identical across all rows
  const start = new Date(e.start_at);
  const when = e.all_day
    ? start.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric', year:'numeric' })
    : start.toLocaleString('en-US', { weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' });
  const where = [e.address_line1, e.city, e.state].filter(Boolean).join(', ') || null;
  const link = (process.env.APP_URL || 'https://os.propspot.io') + '/calendar.html';

  for (const r of rows) {
    try {
      await sendCalendarMentionEmail({
        to: r.email, recipientName: r.recipient_name,
        inviterName: e.inviter_name || r.inviter_name,
        eventTitle: e.title, when, where, link
      });
    } catch (err) {
      console.error('mention email failed for', r.email, err);
    }
  }
}

module.exports = router;
