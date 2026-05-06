// Tiny CRUD helper to keep pipeline routes terse.
// Validates allowlisted columns and parameterizes everything.

const { query } = require('../db');
const { logActivity } = require('./activity');

function buildInsert(table, allowed, body, userId) {
  const cols = ['created_by'];
  const placeholders = ['$1'];
  const vals = [userId];
  let i = 2;
  for (const k of allowed) {
    if (body[k] === undefined) continue;
    cols.push(k);
    placeholders.push(`$${i++}`);
    vals.push(body[k]);
  }
  const sql = `INSERT INTO ${table} (${cols.join(', ')})
               VALUES (${placeholders.join(', ')})
               RETURNING *`;
  return { sql, vals };
}

function buildUpdate(table, allowed, body, idParamIndex) {
  const sets = []; const vals = []; let i = 1;
  for (const k of allowed) {
    if (body[k] === undefined) continue;
    sets.push(`${k} = $${i++}`);
    vals.push(body[k]);
  }
  if (!sets.length) return null;
  const sql = `UPDATE ${table} SET ${sets.join(', ')}, updated_at = NOW()
                WHERE id = $${i} RETURNING *`;
  return { sql, vals };
}

function attachCrud(router, { table, allowedFields, entityType }) {
  router.get('/', async (req, res) => {
    try {
      const params = [];
      let where = '';
      if (req.query.property_id) {
        params.push(req.query.property_id);
        where = `WHERE property_id = $1`;
      }
      const { rows } = await query(`SELECT * FROM ${table} ${where} ORDER BY created_at DESC`, params);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: `Failed to fetch ${table}` }); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const { rows } = await query(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: 'Failed to fetch' }); }
  });

  router.post('/', async (req, res) => {
    if (!req.body.property_id) return res.status(400).json({ error: 'property_id required' });
    try {
      const { sql, vals } = buildInsert(table, allowedFields, req.body, req.userId);
      const { rows } = await query(sql, vals);
      await logActivity({
        actorUserId: req.userId, entityType, entityId: rows[0].id,
        action: 'created', payload: { property_id: rows[0].property_id }
      });
      res.status(201).json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `Failed to create ${entityType}` });
    }
  });

  router.patch('/:id', async (req, res) => {
    const built = buildUpdate(table, allowedFields, req.body, 1);
    if (!built) return res.status(400).json({ error: 'no fields to update' });
    built.vals.push(req.params.id);
    try {
      const { rows } = await query(built.sql, built.vals);
      if (!rows[0]) return res.status(404).json({ error: 'Not found' });
      await logActivity({
        actorUserId: req.userId, entityType, entityId: req.params.id,
        action: req.body.status ? 'status_changed' : 'updated',
        payload: req.body
      });
      res.json(rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: `Failed to update ${entityType}` });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
      await logActivity({
        actorUserId: req.userId, entityType, entityId: req.params.id, action: 'deleted'
      });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to delete' }); }
  });
}

module.exports = { attachCrud, buildInsert, buildUpdate };
