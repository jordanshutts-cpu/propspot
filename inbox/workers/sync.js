// Background sync worker.
// Every INBOX_SYNC_INTERVAL_SECONDS, walks every active mailbox and pulls
// new mail via the Gmail History API. New mailboxes (empty sync_state) get
// a one-time bootstrap of the most recent 50 messages.

const { query } = require('../db');
const gmail     = require('../lib/gmail');
const { parseGmailMessage } = require('../lib/threading');
const { persistMessage }    = require('../lib/persist');

let running   = false;
let timerId   = null;
const intervalSec = parseInt(process.env.INBOX_SYNC_INTERVAL_SECONDS, 10) || 60;

async function syncMailbox(mailbox) {
  console.log(`[sync] mailbox ${mailbox.email} (${mailbox.id})`);
  try {
    const state = mailbox.sync_state || {};
    let messageIds = [];
    let latestHistoryId;

    if (!state.historyId) {
      // Bootstrap: pull recent message IDs and grab current historyId.
      const profile = await gmail.getProfile(mailbox);
      latestHistoryId = profile.historyId;
      messageIds = await gmail.listRecentMessageIds(mailbox, 50);
      console.log(`[sync]   bootstrap: ${messageIds.length} recent messages, historyId=${latestHistoryId}`);
    } else {
      const result = await gmail.listHistorySince(mailbox, state.historyId);
      messageIds = result.messageIds;
      latestHistoryId = result.latestHistoryId;
      console.log(`[sync]   incremental: ${messageIds.length} new since historyId=${state.historyId}`);
    }

    // Fetch + persist each new message.
    for (const id of messageIds) {
      try {
        const full = await gmail.getMessage(mailbox, id);
        const parsed = parseGmailMessage(full, mailbox.email);
        await persistMessage(mailbox, parsed);
      } catch (err) {
        console.error(`[sync]   message ${id} failed:`, err.message);
      }
    }

    // Record progress.
    await query(`
      UPDATE inbox_mailboxes
         SET last_sync_at = NOW(),
             sync_state   = jsonb_set(COALESCE(sync_state, '{}'::jsonb), '{historyId}', to_jsonb($1::text), true),
             status       = 'active',
             status_reason = NULL
       WHERE id = $2
    `, [String(latestHistoryId), mailbox.id]);
  } catch (err) {
    console.error(`[sync] mailbox ${mailbox.email} failed:`, err.message);
    // History expired (404/410) → reset sync_state and bootstrap next cycle.
    if (err.code === 404 || err.code === 410 || /historyId/i.test(err.message)) {
      await query(
        `UPDATE inbox_mailboxes SET sync_state = '{}'::jsonb WHERE id = $1`,
        [mailbox.id]
      );
      return;
    }
    // Otherwise mark as error so the UI surfaces it.
    await query(
      `UPDATE inbox_mailboxes SET status = 'error', status_reason = $1 WHERE id = $2`,
      [err.message.slice(0, 500), mailbox.id]
    );
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const { rows } = await query(
      `SELECT * FROM inbox_mailboxes WHERE status = 'active' ORDER BY last_sync_at NULLS FIRST`
    );
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
