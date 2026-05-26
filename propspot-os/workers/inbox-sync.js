// Background sync worker.
//
// Each connected mailbox passes through three phases:
//
//   bootstrap   → first tick after connection / Resync. Captures the
//                 current Gmail historyId so incremental can resume from
//                 the right point once backfill completes. Transitions
//                 immediately to `backfill`.
//
//   backfill    → paginates through every message in the mailbox via
//                 messages.list (newest-first, 500 per page). Each tick
//                 processes one page. The pageToken is persisted to
//                 sync_state between ticks so a restart resumes mid-
//                 backfill. When the last page completes, transitions to
//                 `incremental` resuming from the historyId captured at
//                 bootstrap.
//
//   incremental → steady state. Each tick pulls new messages via the
//                 History API starting from sync_state.historyId.
//
// Re-running Resync resets sync_state to {} and restarts at bootstrap,
// triggering a fresh full-history backfill. Message persistence is
// idempotent (unique key on provider_message_id), so reprocessing
// existing messages is a no-op.

const { query } = require('../db');
const gmail     = require('../lib/gmail');
const { parseGmailMessage } = require('../lib/threading');
const { persistMessage }    = require('../lib/persist');

let running   = false;
let timerId   = null;
const intervalSec = parseInt(process.env.INBOX_SYNC_INTERVAL_SECONDS, 10) || 60;

// Persist a JSON patch into inbox_mailboxes.sync_state.
async function saveSyncState(mailboxId, patch) {
  await query(`
    UPDATE inbox_mailboxes
       SET last_sync_at = NOW(),
           sync_state   = COALESCE(sync_state, '{}'::jsonb) || $1::jsonb,
           status       = 'active',
           status_reason = NULL
     WHERE id = $2
  `, [JSON.stringify(patch), mailboxId]);
}

// Fetch + persist a batch of message IDs. Errors on individual messages
// are logged but don't abort the whole batch.
async function processMessages(mailbox, messageIds) {
  let ok = 0;
  for (const id of messageIds) {
    try {
      const full = await gmail.getMessage(mailbox, id);
      const parsed = parseGmailMessage(full, mailbox.email);
      await persistMessage(mailbox, parsed);
      ok++;
    } catch (err) {
      console.error(`[sync]   message ${id} failed:`, err.message);
    }
  }
  return ok;
}

async function syncMailbox(mailbox) {
  console.log(`[sync] mailbox ${mailbox.email} (${mailbox.id})`);
  try {
    const state = mailbox.sync_state || {};

    // ── Phase 1: bootstrap (first tick) ───────────────────────────
    if (!state.phase && !state.historyId) {
      const profile = await gmail.getProfile(mailbox);
      console.log(`[sync]   bootstrap: capturing historyId=${profile.historyId}, starting full backfill`);
      await saveSyncState(mailbox.id, {
        phase: 'backfill',
        initialHistoryId: String(profile.historyId),
        backfillPageToken: null,
        backfillMessagesProcessed: 0,
        backfillStartedAt: new Date().toISOString()
      });
      // Fall through and process the first page on this same tick.
      state.phase = 'backfill';
      state.initialHistoryId = String(profile.historyId);
      state.backfillPageToken = null;
      state.backfillMessagesProcessed = 0;
    }

    // ── Legacy migration: old mailboxes with sync_state.historyId but
    //    no phase are already past bootstrap; treat them as `incremental`.
    if (!state.phase && state.historyId) {
      state.phase = 'incremental';
    }

    // ── Phase 2: backfill (one page per tick) ─────────────────────
    if (state.phase === 'backfill') {
      const page = await gmail.listAllMessageIds(mailbox, state.backfillPageToken);
      console.log(`[sync]   backfill page: ${page.messageIds.length} ids (next=${page.nextPageToken ? 'yes' : 'no'})`);
      const ok = await processMessages(mailbox, page.messageIds);
      const newTotal = (state.backfillMessagesProcessed || 0) + ok;

      if (page.nextPageToken) {
        // More pages remain — save token, continue next tick.
        await saveSyncState(mailbox.id, {
          backfillPageToken: page.nextPageToken,
          backfillMessagesProcessed: newTotal
        });
      } else {
        // Last page — transition to incremental from the historyId we
        // captured at bootstrap.
        console.log(`[sync]   backfill complete: ${newTotal} messages, switching to incremental`);
        await saveSyncState(mailbox.id, {
          phase: 'incremental',
          backfillPageToken: null,
          backfillMessagesProcessed: newTotal,
          backfillCompletedAt: new Date().toISOString(),
          historyId: state.initialHistoryId
        });
      }
      return; // Done for this tick.
    }

    // ── Phase 3: incremental (steady state) ───────────────────────
    if (state.phase === 'incremental') {
      const result = await gmail.listHistorySince(mailbox, state.historyId);
      console.log(`[sync]   incremental: ${result.messageIds.length} new since historyId=${state.historyId}`);
      await processMessages(mailbox, result.messageIds);
      await saveSyncState(mailbox.id, {
        historyId: String(result.latestHistoryId)
      });
      return;
    }

    console.warn(`[sync]   unknown phase ${state.phase} — resetting to bootstrap on next tick`);
    await query(`UPDATE inbox_mailboxes SET sync_state = '{}'::jsonb WHERE id = $1`, [mailbox.id]);
  } catch (err) {
    console.error(`[sync] mailbox ${mailbox.email} failed:`, err.message);
    // History expired (404/410) → reset sync_state so the next tick
    // restarts bootstrap + backfill.
    if (err.code === 404 || err.code === 410 || /historyId/i.test(err.message)) {
      await query(
        `UPDATE inbox_mailboxes SET sync_state = '{}'::jsonb WHERE id = $1`,
        [mailbox.id]
      );
      return;
    }
    // Otherwise mark as error so the UI surfaces it. Stamp last_sync_at so
    // the tick() backoff window (5 min) takes effect — without this, a
    // permanently-broken mailbox would be retried every single tick.
    await query(
      `UPDATE inbox_mailboxes
          SET status        = 'error',
              status_reason = $1,
              last_sync_at  = NOW()
        WHERE id = $2`,
      [err.message.slice(0, 500), mailbox.id]
    );
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    // Include error mailboxes with a 5-minute backoff so transient failures
    // (process restart with stale status, brief Google outage, key rotated
    // and then reconnected) self-heal without manual intervention. The
    // error-path UPDATE below sets last_sync_at = NOW() so a permanently
    // broken mailbox only retries every 5 minutes — not every tick.
    const { rows } = await query(`
      SELECT * FROM inbox_mailboxes
       WHERE status = 'active'
          OR (status = 'error'
              AND (last_sync_at IS NULL OR last_sync_at < NOW() - INTERVAL '5 minutes'))
    ORDER BY last_sync_at NULLS FIRST
    `);
    for (const mb of rows) {
      await syncMailbox(mb);
    }
  } catch (err) {
    console.error('[sync] tick failed:', err);
  } finally {
    running = false;
  }
}

function start() {
  if (timerId) return;
  console.log(`[sync] worker starting — interval ${intervalSec}s`);
  // First tick on a short delay so /api/health responds promptly.
  setTimeout(() => { tick(); }, 5000);
  timerId = setInterval(tick, intervalSec * 1000);
}

function stop() {
  if (timerId) { clearInterval(timerId); timerId = null; }
}

module.exports = { start, stop, tick };
