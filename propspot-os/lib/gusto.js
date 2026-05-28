const { query } = require('../db');
const crypto = require('./inbox-crypto');

const GUSTO_API_BASE = process.env.GUSTO_API_BASE || 'https://api.gusto.com';

async function loadSettings() {
  const { rows: [s] } = await query(`SELECT * FROM timesheet_settings WHERE id = 1`);
  return s;
}

async function getAccessToken() {
  if (process.env.GUSTO_TEST_TOKEN) return process.env.GUSTO_TEST_TOKEN;
  const s = await loadSettings();
  if (!s?.gusto_access_encrypted) throw new Error('Gusto not connected');
  return crypto.decrypt(s.gusto_access_encrypted);
}

async function gustoFetch(path, opts = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${GUSTO_API_BASE}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}),
               'Authorization': `Bearer ${token}`,
               'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Gusto ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

async function listEmployees() {
  const s = await loadSettings();
  if (!s.gusto_company_uuid) throw new Error('No Gusto company linked');
  return await gustoFetch(`/v1/companies/${s.gusto_company_uuid}/employees`);
}

async function listPaySchedules() {
  const s = await loadSettings();
  return await gustoFetch(`/v1/companies/${s.gusto_company_uuid}/pay_schedules`);
}

async function listMyCompanies() {
  return await gustoFetch(`/v1/me/companies`);
}

async function pushTimeSheet({ employeeUuid, startDate, endDate,
                                regularMinutes, overtimeMinutes }) {
  const s = await loadSettings();
  const hour_entries = [];
  if (regularMinutes > 0) {
    hour_entries.push({ pay_classification: 'regular',
                        hours: (regularMinutes / 60).toFixed(1) });
  }
  if (overtimeMinutes > 0) {
    hour_entries.push({ pay_classification: 'overtime',
                        hours: (overtimeMinutes / 60).toFixed(1) });
  }
  return await gustoFetch(`/v1/companies/${s.gusto_company_uuid}/time_tracking/time_sheets`, {
    method: 'POST',
    body: JSON.stringify({
      employee_uuid: employeeUuid,
      start_date: startDate,
      end_date: endDate,
      hour_entries,
    }),
  });
}

async function getTimeSheet(uuid) {
  const s = await loadSettings();
  return await gustoFetch(`/v1/companies/${s.gusto_company_uuid}/time_tracking/time_sheets/${uuid}`);
}

function oauthAuthorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GUSTO_CLIENT_ID,
    redirect_uri: process.env.GUSTO_REDIRECT_URI,
    response_type: 'code',
    scope: 'companies:read employees:read time_tracking:read time_tracking:write',
    state,
  });
  return `https://api.gusto.com/oauth/authorize?${params}`;
}

async function exchangeCodeForToken(code) {
  const res = await fetch(`${GUSTO_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GUSTO_CLIENT_ID,
      client_secret: process.env.GUSTO_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: process.env.GUSTO_REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(`Gusto token exchange failed: ${res.status}`);
  return await res.json();
}

async function saveTokens({ access_token, refresh_token, expires_in }) {
  const expiresAt = new Date(Date.now() + expires_in * 1000);
  const accessEnc = crypto.encrypt(access_token);
  const refreshEnc = crypto.encrypt(refresh_token);
  await query(`
    UPDATE timesheet_settings
       SET gusto_access_encrypted = $1,
           gusto_refresh_encrypted = $2,
           gusto_token_expires_at = $3,
           gusto_connected_at = COALESCE(gusto_connected_at, NOW()),
           gusto_disconnected_at = NULL,
           updated_at = NOW()
     WHERE id = 1
  `, [accessEnc, refreshEnc, expiresAt]);
}

async function refreshIfNeeded() {
  const s = await loadSettings();
  if (!s?.gusto_refresh_encrypted) return 0;
  if (s.gusto_token_expires_at && new Date(s.gusto_token_expires_at) > new Date(Date.now() + 60*60*1000)) {
    return 0;
  }
  const refresh_token = crypto.decrypt(s.gusto_refresh_encrypted);
  const res = await fetch(`${GUSTO_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GUSTO_CLIENT_ID,
      client_secret: process.env.GUSTO_CLIENT_SECRET,
      refresh_token, grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    await query(`UPDATE timesheet_settings SET gusto_disconnected_at = NOW() WHERE id = 1`);
    return 0;
  }
  await saveTokens(await res.json());
  return 1;
}

async function ensureNextPayPeriodFromGusto() {
  const schedules = await listPaySchedules().catch(() => []);
  const sch = schedules.find(s => s.frequency === 'Every other week') || schedules[0];
  if (!sch) return 0;
  let count = 0;
  for (const pp of sch.pay_periods || []) {
    const { rowCount } = await query(`
      INSERT INTO timesheet_pay_periods (starts_on, ends_on, payday, gusto_pay_schedule_uuid)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (starts_on, ends_on) DO UPDATE SET payday = EXCLUDED.payday
    `, [pp.start_date, pp.end_date, pp.check_date, sch.uuid]);
    count += rowCount || 0;
  }
  return count;
}

async function pollPushedPeriods() {
  const { rows } = await query(`
    SELECT DISTINCT pay_period_id, gusto_time_sheet_uuid
      FROM timesheet_entries
     WHERE status = 'pushed' AND gusto_time_sheet_uuid IS NOT NULL
     LIMIT 25
  `);
  let flipped = 0;
  for (const r of rows) {
    try {
      const ts = await getTimeSheet(r.gusto_time_sheet_uuid);
      if (ts.processed_at || ts.payroll_uuid) {
        await query(`UPDATE timesheet_entries SET status = 'paid', updated_at = NOW()
                      WHERE gusto_time_sheet_uuid = $1`, [r.gusto_time_sheet_uuid]);
        flipped++;
      }
    } catch (err) { console.error('[gusto] poll:', err.message); }
  }
  return flipped;
}

module.exports = {
  listEmployees, listPaySchedules, pushTimeSheet, getTimeSheet, listMyCompanies,
  gustoFetch,
  oauthAuthorizeUrl, exchangeCodeForToken, saveTokens,
  refreshIfNeeded, ensureNextPayPeriodFromGusto, pollPushedPeriods,
};
