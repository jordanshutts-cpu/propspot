const express = require('express');
const { query } = require('../db');
const { requireAuth, requireInboxGrant } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireInboxGrant);

// GET /api/properties?q=street — typeahead for the "Link to property" picker
// in the thread view. Limited to 30 results and ordered by recent activity.
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = [];
  let where = '';
  if (q) {
    params.push(`%${q}%`);
    where = `WHERE p.address_line1 ILIKE $1 OR p.display_name ILIKE $1 OR p.city ILIKE $1`;
  }
  const { rows } = await query(`
    SELECT p.id, p.address_line1, p.unit, p.city, p.state, p.zip, p.display_name
      FROM properties p
      ${where}
  ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC
     LIMIT 30
  `, params);
  res.json(rows);
});

module.exports = router;
