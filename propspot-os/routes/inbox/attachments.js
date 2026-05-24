const express = require('express');
const { query } = require('../../db');
const { requireAuth, requireInboxGrant } = require('../../middleware/auth');
const { scopedInboxIds } = require('../../lib/inbox-scope');
const gmail = require('../../lib/gmail');
const { uploadBuffer } = require('../../lib/pulse-cloudinary');

const router = express.Router();
router.use(requireAuth);
router.use(requireInboxGrant);

// Helper: load an attachment and confirm the caller can see the parent thread.
async function loadAttachment(req, attachmentId) {
  const allowed = await scopedInboxIds(req.inboxGrant.scope);
  const { rows } = await query(`
    SELECT a.id, a.message_id, a.filename, a.mime_type, a.size_bytes,
           a.provider_attachment_id,
           m.provider_message_id,
           t.id AS thread_id, t.shared_inbox_id, t.mailbox_id,
           mb.email AS mailbox_email
      FROM inbox_attachments a
      JOIN inbox_messages m  ON m.id  = a.message_id
      JOIN inbox_threads t   ON t.id  = m.thread_id
      JOIN inbox_mailboxes mb ON mb.id = t.mailbox_id
     WHERE a.id = $1
  `, [attachmentId]);
  if (!rows[0]) return { error: 'Attachment not found', status: 404 };
  if (allowed !== null && !allowed.includes(rows[0].shared_inbox_id)) {
    return { error: 'No access to this attachment', status: 403 };
  }
  return { att: rows[0] };
}

// GET /api/attachments/:id — stream the raw bytes for inline preview/download.
router.get('/:id', async (req, res) => {
  const loaded = await loadAttachment(req, req.params.id);
  if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });
  try {
    const { rows: mboxRows } = await query(
      `SELECT * FROM inbox_mailboxes WHERE id = $1`, [loaded.att.mailbox_id]
    );
    const buf = await gmail.getAttachmentData(
      mboxRows[0], loaded.att.provider_message_id, loaded.att.provider_attachment_id
    );
    res.setHeader('Content-Type', loaded.att.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${loaded.att.filename}"`);
    res.send(buf);
  } catch (err) {
    console.error('Attachment fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch attachment' });
  }
});

// POST /api/attachments/:id/save-to-property
//   body: { property_id, folder, filename }
router.post('/:id/save-to-property', async (req, res) => {
  const { property_id, folder, filename } = req.body;
  if (!property_id || !filename?.trim()) {
    return res.status(400).json({ error: 'property_id and filename required' });
  }
  const loaded = await loadAttachment(req, req.params.id);
  if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

  try {
    // 1) Confirm the property exists.
    const { rows: propRows } = await query(
      `SELECT id, address_line1 FROM properties WHERE id = $1`, [property_id]
    );
    if (!propRows[0]) return res.status(404).json({ error: 'Property not found' });

    // 2) Pull the raw bytes from Gmail.
    const { rows: mboxRows } = await query(
      `SELECT * FROM inbox_mailboxes WHERE id = $1`, [loaded.att.mailbox_id]
    );
    const buf = await gmail.getAttachmentData(
      mboxRows[0], loaded.att.provider_message_id, loaded.att.provider_attachment_id
    );

    // 3) Resolve or create the folder.
    const folderName = (folder || 'Email attachments').trim();
    let folderId = null;
    const { rows: existing } = await query(
      `SELECT id FROM folders WHERE property_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
      [property_id, folderName]
    );
    if (existing[0]) {
      folderId = existing[0].id;
    } else {
      const { rows: created } = await query(
        `INSERT INTO folders (property_id, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [property_id, folderName, req.userId]
      );
      folderId = created[0].id;
    }

    // 4) Upload to Cloudinary, scoped under propspot/inbox/<property>.
    const cloudinaryFolder = `propspot/properties/${property_id}/inbox`;
    const baseName = filename.trim().replace(/\.[^/.]+$/, '');
    const upload = await uploadBuffer(buf, {
      folder: cloudinaryFolder,
      public_id: baseName,
      mimeType: loaded.att.mime_type
    });

    // 5) Write a `photos` row so it shows up in FieldCam under the property.
    const { rows: photoRows } = await query(
      `INSERT INTO photos (property_id, uploaded_by, url, cloudinary_id, folder_id,
                           media_type, notes)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $6::text LIKE 'image/%' THEN 'image' ELSE 'file' END,
               $7)
       RETURNING id`,
      [
        property_id, req.userId, upload.url, upload.cloudinary_id, folderId,
        loaded.att.mime_type,
        `Saved from email attachment "${loaded.att.filename}"`
      ]
    );

    // 6) Record the save so we don't re-save the same attachment twice.
    await query(
      `INSERT INTO inbox_attachment_saves
         (attachment_id, property_id, photo_id, saved_filename, saved_folder, saved_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [loaded.att.id, property_id, photoRows[0].id, filename.trim(), folderName, req.userId]
    );

    res.status(201).json({
      success: true,
      photo_id: photoRows[0].id,
      url: upload.url,
      folder: folderName
    });
  } catch (err) {
    console.error('Save-to-property failed:', err);
    res.status(500).json({ error: 'Failed to save attachment: ' + err.message });
  }
});

module.exports = router;
