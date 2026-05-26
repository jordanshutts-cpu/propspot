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
  const allowed = await scopedInboxIds(req.inboxGrant.scope, req.userId);
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

// POST /api/inbox/attachments/:id/save-to-files
//   body: { filename, property_id (optional) }
// Saves the attachment as a drive_files row so it shows up in the Files
// app. property_id is optional — when set, the row is also tagged to the
// property so it appears in that property's Files section.
router.post('/:id/save-to-files', async (req, res) => {
  const { filename, property_id } = req.body;
  if (!filename?.trim()) return res.status(400).json({ error: 'filename required' });

  const loaded = await loadAttachment(req, req.params.id);
  if (loaded.error) return res.status(loaded.status).json({ error: loaded.error });

  try {
    if (property_id) {
      const { rows: propRows } = await query(
        `SELECT id FROM properties WHERE id = $1`, [property_id]
      );
      if (!propRows[0]) return res.status(404).json({ error: 'Property not found' });
    }

    // Pull the raw bytes from Gmail.
    const { rows: mboxRows } = await query(
      `SELECT * FROM inbox_mailboxes WHERE id = $1`, [loaded.att.mailbox_id]
    );
    const buf = await gmail.getAttachmentData(
      mboxRows[0], loaded.att.provider_message_id, loaded.att.provider_attachment_id
    );

    // Upload to Cloudinary. Scope path mirrors the destination so files
    // saved to a property cluster together in Cloudinary, while general
    // saves go under propspot/drive/inbox/.
    const cloudinaryFolder = property_id
      ? `propspot/properties/${property_id}/inbox`
      : `propspot/drive/inbox`;
    const baseName = filename.trim().replace(/\.[^/.]+$/, '');
    const upload = await uploadBuffer(buf, {
      folder: cloudinaryFolder,
      public_id: baseName,
      mimeType: loaded.att.mime_type
    });

    // Write to drive_files. folder_id is null (top-level Files); property_id
    // is set if the caller picked a property. team_visible defaults to true
    // so it appears in everyone's Files app.
    const { rows: fileRows } = await query(
      `INSERT INTO drive_files
         (folder_id, property_id, filename, url, cloudinary_id,
          mime_type, size_bytes, uploaded_by, drive_type)
       VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, 'shared')
       RETURNING id, url`,
      [
        property_id || null,
        filename.trim(),
        upload.url,
        upload.cloudinary_id,
        loaded.att.mime_type,
        loaded.att.size_bytes || null,
        req.userId
      ]
    );

    // Record the save for dedup. inbox_attachment_saves has a non-null
    // property_id column today, so we only insert when a property was set.
    if (property_id) {
      try {
        await query(
          `INSERT INTO inbox_attachment_saves
             (attachment_id, property_id, photo_id, saved_filename, saved_folder, saved_by)
           VALUES ($1, $2, NULL, $3, 'Email attachments', $4)`,
          [loaded.att.id, property_id, filename.trim(), req.userId]
        );
      } catch (e) { console.warn('inbox_attachment_saves insert failed (non-fatal):', e.message); }
    }

    res.status(201).json({
      success: true,
      file_id: fileRows[0].id,
      url: fileRows[0].url,
      property_id: property_id || null
    });
  } catch (err) {
    console.error('Save-to-files failed:', err);
    res.status(500).json({ error: 'Failed to save attachment: ' + err.message });
  }
});

module.exports = router;
