const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const { query } = require('../../db');
const { resetTimesheetTables, ensureTestUser, ensureTestPayPeriod } =
  require('./helpers');

function makeApp(userId, role = 'admin') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    req.timesheetsGrant = { role, scope: { all: true } };
    req.user = { id: userId };
    next();
  });
  app.use('/api/timesheets', require('../../routes/timesheets/admin'));
  return app;
}

function request(app, method, path, body) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request({ method, host: '127.0.0.1', port, path,
        headers: { 'content-type': 'application/json' } }, (res) => {
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => { server.close();
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); });
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

test('GET /live returns clocked-in workers', async () => {
  await resetTimesheetTables();
  const admin = await ensureTestUser('admin@example.com', 'Admin');
  const worker = await ensureTestUser('worker@example.com', 'Worker');
  await ensureTestPayPeriod();
  await query(`INSERT INTO timesheet_entries (user_id, started_at)
               VALUES ($1, NOW() - INTERVAL '15 minutes')`, [worker.id]);
  const app = makeApp(admin.id);
  const res = await request(app, 'GET', '/api/timesheets/live');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.length, 1);
  assert.strictEqual(res.body[0].user_id, worker.id);
});

test('POST approve flips worker entries to approved', async () => {
  await resetTimesheetTables();
  const admin = await ensureTestUser('admin@example.com', 'Admin');
  const worker = await ensureTestUser('worker@example.com', 'Worker');
  const pp = await ensureTestPayPeriod();
  await query(`
    INSERT INTO timesheet_entries (user_id, pay_period_id, started_at, ended_at,
                                   duration_minutes, status)
    VALUES ($1, $2, '2026-05-19T09:00:00Z', '2026-05-19T17:00:00Z', 480, 'open')
  `, [worker.id, pp.id]);
  const app = makeApp(admin.id);
  const res = await request(app, 'POST',
    `/api/timesheets/pay-periods/${pp.id}/workers/${worker.id}/approve`);
  assert.strictEqual(res.status, 200);
  const { rows } = await query(
    `SELECT status FROM timesheet_entries WHERE user_id = $1`, [worker.id]);
  assert.strictEqual(rows[0].status, 'approved');
});

test('POST unlock reverts a single approved entry to open', async () => {
  await resetTimesheetTables();
  const admin = await ensureTestUser('admin@example.com', 'Admin');
  const worker = await ensureTestUser('worker@example.com', 'Worker');
  const pp = await ensureTestPayPeriod();
  const { rows: [e] } = await query(`
    INSERT INTO timesheet_entries (user_id, pay_period_id, started_at, ended_at,
                                   duration_minutes, status)
    VALUES ($1, $2, '2026-05-19T09:00:00Z', '2026-05-19T17:00:00Z', 480, 'approved')
    RETURNING id
  `, [worker.id, pp.id]);
  const app = makeApp(admin.id);
  const res = await request(app, 'POST', `/api/timesheets/entries/${e.id}/unlock`,
                            { reason: 'fix tag' });
  assert.strictEqual(res.status, 200);
  const { rows } = await query(`SELECT status FROM timesheet_entries WHERE id = $1`, [e.id]);
  assert.strictEqual(rows[0].status, 'open');
});

test('GET /pay-periods/:id/csv returns CSV text', async () => {
  await resetTimesheetTables();
  const admin = await ensureTestUser('admin@example.com', 'Admin');
  const worker = await ensureTestUser('worker@example.com', 'Worker');
  const pp = await ensureTestPayPeriod();
  await query(`
    INSERT INTO timesheet_entries (user_id, pay_period_id, started_at, ended_at,
                                   duration_minutes, status)
    VALUES ($1, $2, '2026-05-19T09:00:00Z', '2026-05-19T17:00:00Z', 480, 'approved')
  `, [worker.id, pp.id]);
  const app = makeApp(admin.id);
  const res = await request(app, 'GET', `/api/timesheets/pay-periods/${pp.id}/csv`);
  assert.strictEqual(res.status, 200);
});
