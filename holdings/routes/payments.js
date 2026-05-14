const express = require('express');
const { query } = require('../db');
const { requireAuth, requireHoldingsGrant } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireHoldingsGrant);

// POST /api/payments — record a payment and advance the holding's next_due_at.
// Body: { holding_id, paid_on, amount_cents, method, notes }
router.post('/', async (req, res) => {
  const { holding_id, paid_on, amount_cents, method, notes } = req.body;
  if (!holding_id)       return res.status(400).json({ error: 'holding_id required' });
  if (!paid_on)          return res.status(400).json({ error: 'paid_on required' });

  try {
    // Insert the payment row
    const { rows: payRows } = await query(`
      INSERT INTO holding_payments (holding_id, paid_on, amount_cents, method, notes, recorded_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      holding_id, paid_on,
      amount_cents != null ? parseInt(amount_cents, 10) : null,
      method?.trim() || null,
      notes?.trim() || null,
      req.userId
    ]);

    // Advance the holding: set last_paid_at and bump next_due_at by cadence.
    const { rows: hRows } = await query(`SELECT cadence, next_due_at FROM holdings WHERE id = $1`, [holding_id]);
    const h = hRows[0];
    if (h) {
      const cadenceMonths = {
        monthly: 1, quarterly: 3, semiannual: 6, annual: 12, one_time: 0
      };
      const months = cadenceMonths[h.cadence] ?? 1;
      if (months === 0) {
        await query(
          `UPDATE holdings SET last_paid_at = $1, is_active = FALSE, updated_at = NOW() WHERE id = $2`,
          [paid_on, holding_id]
        );
      } else {
        await query(
          `UPDATE holdings
              SET last_paid_at = $1,
                  next_due_at  = COALESCE(next_due_at, $1::date) + ($2::int || ' months')::interval,
                  updated_at   = NOW()
            WHERE id = $3`,
          [paid_on, months, holding_id]
        );
      }
    }

    res.status(201).json(payRows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record payment' });
  }
});

// DELETE /api/payments/:id — undo a payment (does NOT roll back next_due_at).
router.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM holding_payments WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete payment' });
  }
});

module.exports = router;
