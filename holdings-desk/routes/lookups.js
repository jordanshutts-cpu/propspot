// Read-only lookups against the shared Prop Spot DB. Used by the satellite's
// UI to populate property and contact pickers without crossing the network
// to Prop Spot's API. Auth is required (same JWT_SECRET).

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/lookups/properties — minimal field set; ordered by recency.
router.get('/properties', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, address_line1, unit, city, state, zip, display_name
        FROM properties
       ORDER BY COALESCE(display_name, address_line1)
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch properties' });
  }
});

// GET /api/lookups/properties/:id — single property for the per-property
// holdings view header.
router.get('/properties/:id', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, address_line1, unit, city, state, zip, display_name
        FROM properties
       WHERE id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Property not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch property' });
  }
});

// GET /api/lookups/contacts — for the "Link Contact" picker.
router.get('/contacts', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, type, full_name, email, phone, company
        FROM contacts
       ORDER BY full_name
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

module.exports = router;
