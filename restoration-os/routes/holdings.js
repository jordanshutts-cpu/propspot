// Holdings Desk lives in a separate satellite app at /home/user/propspot/holdings-desk/
// (deployed at holdings.propspot.io). Prop Spot keeps ONE read-only endpoint
// here — /summary — so the dashboard can render portfolio-wide totals
// without a cross-service hop. Tables (holdings_items, holdings_payments,
// holdings_documents) still live in this DB; the satellite owns all writes.

const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/holdings/summary — portfolio-wide rollup for the dashboard tile.
router.get('/summary', async (req, res) => {
  try {
    const [summary, byCat] = await Promise.all([
      query(`
        SELECT
          COALESCE(SUM(CASE frequency
            WHEN 'monthly'    THEN COALESCE(amount, 0)
            WHEN 'quarterly'  THEN COALESCE(amount, 0) / 3
            WHEN 'semiannual' THEN COALESCE(amount, 0) / 6
            WHEN 'annual'     THEN COALESCE(amount, 0) / 12
            ELSE 0
          END), 0)::numeric(12,2) AS monthly_carry,
          COUNT(*) FILTER (WHERE next_due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7)::int AS due_this_week,
          COUNT(*) FILTER (WHERE next_due_date < CURRENT_DATE)::int AS overdue,
          COUNT(*)::int AS active_count
          FROM holdings_items
         WHERE status = 'active'
      `),
      query(`
        SELECT category, COUNT(*)::int AS count
          FROM holdings_items
         WHERE status = 'active'
         GROUP BY category
      `)
    ]);
    const by_category = byCat.rows.reduce((acc, r) => { acc[r.category] = r.count; return acc; }, {});
    res.json({ ...summary.rows[0], by_category });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch holdings summary' });
  }
});

module.exports = router;
