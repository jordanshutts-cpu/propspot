const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { query } = require('../../db');
const { resetTimesheetTables, ensureTestUser, ensureTestPayPeriod } =
  require('./helpers');

// Mount the router with a fake auth/authz that fills req.userId.
function makeApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    req.timesheetsGrant = { role: 'member', scope: { all: true } };
    next();
  });
  // Skip the real middleware chain by mounting the inner router directly.
  const router = require('../../routes/timesheets/entries');
  app.use('/api/timesheets', router);
  return app;
}

async function request(app, method, path, body) {
  return new Promise((resolve) => {
    const fetch = require('node:http');
    const server = app.listen(0, () => {
      const { port } = server.address();
      const options = { method, host: '127.0.0.1', port, path,
                        headers: { 'content-type': 'application/json' } };
      const r = fetch.request(options, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
      });
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  });
}

test('POST /clock-in creates an open entry', async () => {
  await resetTimesheetTables();
  const user = await ensureTestUser();
  await ensureTestPayPeriod();
  const app = makeApp(user.id);

  const res = await request(app, 'POST', '/api/timesheets/clock-in',
                            { category: 'Acquisitions' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.id);
  assert.strictEqual(res.body.ended_at, null);
  assert.strictEqual(res.body.category, 'Acquisitions');
});

test('POST /clock-in rejects when user already clocked in', async () => {
  await resetTimesheetTables();
  const user = await ensureTestUser();
  await ensureTestPayPeriod();
  await query(
    `INSERT INTO timesheet_entries (user_id, started_at) VALUES ($1, NOW())`,
    [user.id]
  );
  const app = makeApp(user.id);

  const res = await request(app, 'POST', '/api/timesheets/clock-in', {});
  assert.strictEqual(res.status, 409);
  assert.match(res.body.error, /already clocked in/i);
});

test('POST /clock-out closes the open entry with duration', async () => {
  await resetTimesheetTables();
  const user = await ensureTestUser();
  await ensureTestPayPeriod();
  await query(`
    INSERT INTO timesheet_entries (user_id, started_at)
    VALUES ($1, NOW() - INTERVAL '30 minutes')
  `, [user.id]);
  const app = makeApp(user.id);

  const res = await request(app, 'POST', '/api/timesheets/clock-out', {});
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.ended_at);
  assert.ok(res.body.duration_minutes >= 29 && res.body.duration_minutes <= 31);
});

test('POST /clock-out 404s when no open entry', async () => {
  await resetTimesheetTables();
  const user = await ensureTestUser();
  const app = makeApp(user.id);

  const res = await request(app, 'POST', '/api/timesheets/clock-out', {});
  assert.strictEqual(res.status, 404);
});

test('POST /switch closes current and opens new in one call', async () => {
  await resetTimesheetTables();
  const user = await ensureTestUser();
  await ensureTestPayPeriod();
  await query(`
    INSERT INTO timesheet_entries (user_id, started_at, category)
    VALUES ($1, NOW() - INTERVAL '15 minutes', 'Acquisitions')
  `, [user.id]);
  const app = makeApp(user.id);

  const res = await request(app, 'POST', '/api/timesheets/switch',
                            { category: 'Underwriting' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.category, 'Underwriting');
  assert.strictEqual(res.body.ended_at, null);
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM timesheet_entries
     WHERE user_id = $1 AND ended_at IS NOT NULL`, [user.id]);
  assert.strictEqual(rows[0].n, 1); // the old one is closed
});

test('GET /me/current returns open entry, or null', async () => {
  await resetTimesheetTables();
  const user = await ensureTestUser();
  const app = makeApp(user.id);

  let res = await request(app, 'GET', '/api/timesheets/me/current');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, null);

  await query(`INSERT INTO timesheet_entries (user_id, started_at) VALUES ($1, NOW())`, [user.id]);
  res = await request(app, 'GET', '/api/timesheets/me/current');
  assert.ok(res.body.id);
  assert.strictEqual(res.body.ended_at, null);
});
