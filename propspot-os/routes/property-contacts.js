const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');
const { recomputeScopeForContact } = require('../lib/scope');

const router = express.Router();
router.use(requireAuth);

// POST /api/property-contacts  { property_id, contact_id, role, is_primary? }
router.post('/', async (req, res) => {
  const { property_id, contact_id, role, is_primary, notes } = req.body;
  if (!property_id || !contact_id || !role) {
    return res.status(400).json({ error: 'property_id, contact_id, role required' });
  }
  try {
    const { rows } = await query(`
      INSERT INTO property_contacts (property_id, contact_id, role, is_primary, notes)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (property_id, contact_id, role) DO UPDATE
        SET is_primary = EXCLUDED.is_primary, notes = EXCLUDED.notes
      RETURNING *
    `, [property_id, contact_id, role, !!is_primary, notes || null]);

    // If a user is linked to this contact and has a project-scoped grant, sync it.
    await recomputeScopeForContact(contact_id);

    await logActivity({
      actorUserId: req.userId, entityType: 'property', entityId: property_id,
      action: 'linked', payload: { contact_id, role }
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to link contact' });
  }
});

// DELETE /api/property-contacts  { property_id, contact_id, role }
router.delete('/', async (req, res) => {
  const { property_id, contact_id, role } = req.body;
  if (!property_id || !contact_id || !role) {
    return res.status(400).json({ error: 'property_id, contact_id, role required' });
  }
  try {
    await query(
      `DELETE FROM property_contacts WHERE property_id = $1 AND contact_id = $2 AND role = $3`,
      [property_id, contact_id, role]
    );
    await recomputeScopeForContact(contact_id);
    await logActivity({
      actorUserId: req.userId, entityType: 'property', entityId: property_id,
      action: 'unlinked', payload: { contact_id, role }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unlink contact' });
  }
});

module.exports = router;
