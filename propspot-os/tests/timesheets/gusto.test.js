const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { query } = require('../../db');
const { resetTimesheetTables } = require('./helpers');

function startFakeGusto(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const response = handler(req, body);
      res.writeHead(response.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body || {}));
    });
  });
  return new Promise(resolve => server.listen(0, () => {
    const { port } = server.address();
    process.env.GUSTO_API_BASE = `http://127.0.0.1:${port}`;
    resolve(server);
  }));
}

test('listEmployees calls Gusto /companies/{uuid}/employees and returns array', async () => {
  await resetTimesheetTables();
  const fake = await startFakeGusto((req) => {
    assert.strictEqual(req.url, '/v1/companies/co-123/employees');
    return { body: [{ uuid: 'emp-1', email: 'jen@example.com',
                      first_name: 'Jen', last_name: 'Slipakoff' }] };
  });
  delete require.cache[require.resolve('../../lib/gusto')];
  await query(`UPDATE timesheet_settings SET gusto_company_uuid = 'co-123',
               gusto_access_encrypted = NULL WHERE id = 1`);
  process.env.GUSTO_TEST_TOKEN = 'fake-token';
  const { listEmployees } = require('../../lib/gusto');
  const emps = await listEmployees();
  assert.strictEqual(emps.length, 1);
  assert.strictEqual(emps[0].email, 'jen@example.com');
  fake.close();
});

test('pushTimeSheet posts to time_tracking/time_sheets with regular+ot split', async () => {
  await resetTimesheetTables();
  let received = null;
  const fake = await startFakeGusto((req, body) => {
    received = { url: req.url, body: JSON.parse(body) };
    return { status: 201, body: { uuid: 'ts-999' } };
  });
  await query(`UPDATE timesheet_settings SET gusto_company_uuid = 'co-123' WHERE id = 1`);
  process.env.GUSTO_TEST_TOKEN = 'fake-token';
  delete require.cache[require.resolve('../../lib/gusto')];
  const { pushTimeSheet } = require('../../lib/gusto');

  const result = await pushTimeSheet({
    employeeUuid: 'emp-1',
    startDate: '2026-05-18',
    endDate:   '2026-05-31',
    regularMinutes: 40 * 60,
    overtimeMinutes: 5 * 60,
  });
  assert.strictEqual(result.uuid, 'ts-999');
  assert.strictEqual(received.url,
    '/v1/companies/co-123/time_tracking/time_sheets');
  assert.strictEqual(received.body.employee_uuid, 'emp-1');
  assert.ok(Array.isArray(received.body.hour_entries));
  const reg = received.body.hour_entries.find(h => h.pay_classification === 'regular');
  const ot  = received.body.hour_entries.find(h => h.pay_classification === 'overtime');
  assert.strictEqual(reg.hours, '40.0');
  assert.strictEqual(ot.hours, '5.0');
  fake.close();
});
