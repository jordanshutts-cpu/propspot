const { query } = require('../db');

async function autoCloseStale() {
  const { rowCount } = await query(`
    UPDATE timesheet_entries
       SET ended_at = started_at + INTERVAL '14 hours',
           duration_minutes = 14 * 60,
           auto_closed = TRUE,
           updated_at = NOW()
     WHERE ended_at IS NULL
       AND started_at < NOW() - INTERVAL '14 hours'
       AND deleted_at IS NULL
  `);
  return rowCount || 0;
}

async function assignPayPeriods() {
  const { rowCount } = await query(`
    UPDATE timesheet_entries e
       SET pay_period_id = pp.id, updated_at = NOW()
      FROM timesheet_pay_periods pp
     WHERE e.pay_period_id IS NULL
       AND e.started_at::date BETWEEN pp.starts_on AND pp.ends_on
  `);
  return rowCount || 0;
}

async function ensureNextPayPeriod() {
  const { rows: [s] } = await query(`SELECT gusto_company_uuid FROM timesheet_settings WHERE id = 1`);
  if (!s?.gusto_company_uuid) return 0;
  const { ensureNextPayPeriodFromGusto } = require('../lib/gusto');
  return await ensureNextPayPeriodFromGusto();
}

async function refreshGustoTokens() {
  const { refreshIfNeeded } = require('../lib/gusto');
  return await refreshIfNeeded().catch(err => {
    console.error('[timesheets] token refresh failed:', err.message);
    return 0;
  });
}
async function pollGustoPayroll() {
  const { pollPushedPeriods } = require('../lib/gusto');
  return await pollPushedPeriods().catch(err => {
    console.error('[timesheets] payroll poll failed:', err.message);
    return 0;
  });
}

let timers = [];
function start() {
  if (timers.length) return;
  const min = 60 * 1000;
  timers.push(setInterval(() => autoCloseStale().catch(err => console.error('[ts] autoClose:', err)), 10 * min));
  timers.push(setInterval(() => assignPayPeriods().catch(err => console.error('[ts] assignPP:', err)), 60 * min));
  timers.push(setInterval(() => ensureNextPayPeriod().catch(err => console.error('[ts] ensureNextPP:', err)), 60 * 60 * 1000));
  timers.push(setInterval(() => refreshGustoTokens().catch(err => console.error('[ts] refresh:', err)), 30 * min));
  timers.push(setInterval(() => pollGustoPayroll().catch(err => console.error('[ts] poll:', err)), 4 * 60 * min));
  console.log('[timesheets-worker] started');
}
function stop() { timers.forEach(clearInterval); timers = []; }

module.exports = { start, stop, autoCloseStale, assignPayPeriods, ensureNextPayPeriod,
                   refreshGustoTokens, pollGustoPayroll };
