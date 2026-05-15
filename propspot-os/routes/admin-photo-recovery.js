const express = require('express');
const cloudinary = require('cloudinary').v2;
const { query } = require('../db');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { logActivity } = require('../lib/activity');

const router = express.Router();
router.use(requireAuth);
router.use(requireOwner);

router.post('/', async (req, res) => {
  const { from_property_id, to_property_id } = req.body;
  if (!from_property_id || !to_property_id) {
    return res.status(400).json({ error: 'from_property_id and to_property_id required' });
  }

  const { rows: destCheck } = await query(
    'SELECT id FROM properties WHERE id = $1', [to_property_id]
  );
  if (!destCheck[0]) return res.status(404).json({ error: 'destination property not found' });

  const folderPrefix = `fieldcam/${from_property_id}`;
  const found = [];
  let pages = 0;

  try {
    for (const resource_type of ['image', 'video']) {
      let nextCursor = null;
      do {
        const r = await cloudinary.api.resources({
          type: 'upload',
          resource_type,
          prefix: folderPrefix,
          max_results: 500,
          ...(nextCursor ? { next_cursor: nextCursor } : {})
        });
        for (const resource of (r.resources || [])) {
          found.push({
            public_id:  resource.public_id,
            secure_url: resource.secure_url,
            resource_type
          });
        }
        nextCursor = r.next_cursor || null;
        pages++;
      } while (nextCursor);
    }
  } catch (err) {
    console.error('Cloudinary list failed:', err);
    return res.status(502).json({ error: 'Cloudinary list failed: ' + (err.message || err) });
  }

  let inserted = 0, skipped = 0;
  for (const r of found) {
    const { rows: existing } = await query(
      'SELECT id FROM photos WHERE cloudinary_id = $1 AND property_id = $2',
      [r.public_id, to_property_id]
    );
    if (existing[0]) { skipped++; continue; }
    await query(`
      INSERT INTO photos
        (property_id, uploaded_by, url, cloudinary_id, media_type, taken_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [
      to_property_id, req.userId, r.secure_url, r.public_id,
      r.resource_type === 'video' ? 'video' : 'image'
    ]);
    inserted++;
  }

  await logActivity({
    actorUserId: req.userId, entityType: 'property', entityId: to_property_id,
    action: 'photos_recovered',
    payload: { from_property_id, found: found.length, inserted, skipped, pages }
  });

  res.json({
    cloudinary_folder: folderPrefix,
    found_in_cloudinary: found.length,
    inserted,
    skipped_already_present: skipped,
    pages_walked: pages
  });
});

module.exports = router;
