const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const https = require('https');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── Permission helper (same logic as drive.js) ─────────────────────
async function getEffectiveRole(userId, type, id) {
  const { rows: [user] } = await query(`SELECT is_owner FROM users WHERE id = $1`, [userId]);
  if (user && user.is_owner) return 'owner';

  if (type === 'file') {
    const { rows: [perm] } = await query(
      `SELECT role FROM drive_permissions WHERE file_id = $1 AND user_id = $2`, [id, userId]);
    if (perm) return perm.role;
    const { rows: [file] } = await query(`SELECT folder_id, team_visible, uploaded_by FROM drive_files WHERE id = $1`, [id]);
    if (!file) return null;
    if (file.uploaded_by === userId) return 'owner';
    if (file.folder_id) return getEffectiveRole(userId, 'folder', file.folder_id);
    return file.team_visible ? 'viewer' : null;
  }

  if (type === 'folder') {
    const { rows: [perm] } = await query(
      `SELECT role FROM drive_permissions WHERE folder_id = $1 AND user_id = $2`, [id, userId]);
    if (perm) return perm.role;
    const { rows: [folder] } = await query(`SELECT parent_id, team_visible, created_by FROM drive_folders WHERE id = $1`, [id]);
    if (!folder) return null;
    if (folder.created_by === userId) return 'owner';
    if (folder.parent_id) return getEffectiveRole(userId, 'folder', folder.parent_id);
    return folder.team_visible ? 'viewer' : null;
  }
  return null;
}

const ROLE_LEVEL = { viewer: 1, editor: 2, owner: 3 };
function hasRole(effective, required) {
  return effective && ROLE_LEVEL[effective] >= ROLE_LEVEL[required];
}

// ── GET /api/drive/sync/status ────────────────────────────────────
// Health check + returns server time for clock-sync
router.get('/status', async (req, res) => {
  try {
    const { rows: [{ now }] } = await query(`SELECT NOW() AS now`);
    res.json({ ok: true, server_time: now, version: '1.0.0' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Database unavailable' });
  }
});

// ── POST /api/drive/sync/register-device ──────────────────────────
// Register or update a sync client device
router.post('/register-device', async (req, res) => {
  try {
    const { device_id, device_name, platform } = req.body;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });

    const { rows: [cursor] } = await query(`
      INSERT INTO drive_sync_cursors (user_id, device_id, device_name, platform)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, device_id)
      DO UPDATE SET device_name = COALESCE($3, drive_sync_cursors.device_name),
                    platform = COALESCE($4, drive_sync_cursors.platform),
                    last_seen = NOW()
      RETURNING *
    `, [req.userId, device_id, device_name || null, platform || null]);

    res.json(cursor);
  } catch (err) {
    console.error('register-device error:', err);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// ── GET /api/drive/sync/tree ──────────────────────────────────────
// Full folder + file tree for initial sync. Returns everything the
// user has access to.
router.get('/tree', async (req, res) => {
  try {
    const { drive_type } = req.query;

    let folderSql = `
      SELECT id, parent_id, property_id, name, team_visible, drive_type,
             created_by, created_at, updated_at, version
        FROM drive_folders WHERE 1=1
    `;
    const folderParams = [];
    if (drive_type) {
      folderParams.push(drive_type);
      folderSql += ` AND drive_type = $${folderParams.length}`;
    }
    folderSql += ` ORDER BY name`;
    const { rows: allFolders } = await query(folderSql, folderParams);

    const folders = [];
    for (const f of allFolders) {
      if (f.drive_type === 'personal' && f.created_by !== req.userId) continue;
      if (f.team_visible || f.created_by === req.userId) {
        folders.push(f);
      } else {
        const role = await getEffectiveRole(req.userId, 'folder', f.id);
        if (role) folders.push(f);
      }
    }

    const folderIds = folders.map(f => f.id);

    let files = [];
    if (folderIds.length > 0) {
      const { rows } = await query(`
        SELECT id, folder_id, property_id, filename, url, cloudinary_id,
               mime_type, size_bytes, team_visible, drive_type,
               uploaded_by, created_at, updated_at, version, content_hash
          FROM drive_files
         WHERE folder_id = ANY($1)
         ORDER BY filename
      `, [folderIds]);
      files = rows;
    }

    // Also get root-level files
    let rootSql = `
      SELECT id, folder_id, property_id, filename, url, cloudinary_id,
             mime_type, size_bytes, team_visible, drive_type,
             uploaded_by, created_at, updated_at, version, content_hash
        FROM drive_files WHERE folder_id IS NULL
    `;
    const rootParams = [];
    if (drive_type) {
      rootParams.push(drive_type);
      rootSql += ` AND drive_type = $${rootParams.length}`;
    }
    rootSql += ` ORDER BY filename`;
    const { rows: rootFiles } = await query(rootSql, rootParams);
    files = files.concat(rootFiles);

    const { rows: [{ now }] } = await query(`SELECT NOW() AS now`);

    res.json({
      folders,
      files,
      cursor: now
    });
  } catch (err) {
    console.error('sync tree error:', err);
    res.status(500).json({ error: 'Failed to build sync tree' });
  }
});

// ── GET /api/drive/sync/changes ───────────────────────────────────
// Delta sync: returns items changed since cursor (ISO timestamp).
// Also returns tombstones for deleted items.
router.get('/changes', async (req, res) => {
  try {
    const { cursor, device_id } = req.query;
    if (!cursor) return res.status(400).json({ error: 'cursor parameter required' });

    const since = new Date(cursor);
    if (isNaN(since.getTime())) return res.status(400).json({ error: 'Invalid cursor timestamp' });

    const { rows: changedFolders } = await query(`
      SELECT id, parent_id, property_id, name, team_visible, drive_type,
             created_by, created_at, updated_at, version
        FROM drive_folders
       WHERE updated_at > $1
       ORDER BY updated_at
    `, [since]);

    const visibleFolders = [];
    for (const f of changedFolders) {
      if (f.drive_type === 'personal' && f.created_by !== req.userId) continue;
      if (f.team_visible || f.created_by === req.userId) {
        visibleFolders.push(f);
      } else {
        const role = await getEffectiveRole(req.userId, 'folder', f.id);
        if (role) visibleFolders.push(f);
      }
    }

    const { rows: changedFiles } = await query(`
      SELECT id, folder_id, property_id, filename, url, cloudinary_id,
             mime_type, size_bytes, team_visible, drive_type,
             uploaded_by, created_at, updated_at, version, content_hash
        FROM drive_files
       WHERE updated_at > $1
       ORDER BY updated_at
    `, [since]);

    const { rows: tombstones } = await query(`
      SELECT id, item_type, item_id, parent_id, filename, deleted_at
        FROM drive_sync_tombstones
       WHERE deleted_at > $1
       ORDER BY deleted_at
    `, [since]);

    const { rows: [{ now }] } = await query(`SELECT NOW() AS now`);

    if (device_id) {
      await query(`
        UPDATE drive_sync_cursors
           SET cursor_at = $3, last_seen = NOW()
         WHERE user_id = $1 AND device_id = $2
      `, [req.userId, device_id, now]);
    }

    res.json({
      folders: visibleFolders,
      files: changedFiles,
      deleted: tombstones,
      cursor: now,
      has_more: false
    });
  } catch (err) {
    console.error('sync changes error:', err);
    res.status(500).json({ error: 'Failed to get changes' });
  }
});

// ── GET /api/drive/sync/download/:fileId ──────────────────────────
// Stream file content from Cloudinary for local sync
router.get('/download/:fileId', async (req, res) => {
  try {
    const { rows: [file] } = await query(
      `SELECT * FROM drive_files WHERE id = $1`, [req.params.fileId]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const role = await getEffectiveRole(req.userId, 'file', file.id);
    if (!hasRole(role, 'viewer')) return res.status(403).json({ error: 'No permission' });

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    if (file.size_bytes) res.setHeader('Content-Length', file.size_bytes);
    res.setHeader('X-PropSpot-Version', file.version || 1);
    if (file.content_hash) res.setHeader('ETag', `"${file.content_hash}"`);

    https.get(file.url, (stream) => {
      stream.pipe(res);
    }).on('error', (err) => {
      console.error('download proxy error:', err);
      if (!res.headersSent) res.status(502).json({ error: 'Failed to fetch file' });
    });
  } catch (err) {
    console.error('download error:', err);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// ── POST /api/drive/sync/upload ───────────────────────────────────
// Upload with conflict detection via version number
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { folder_id, property_id, drive_type, file_id, expected_version } = req.body;

    const contentHash = crypto.createHash('md5').update(req.file.buffer).digest('hex');

    // Update existing file (sync overwrite)
    if (file_id) {
      const { rows: [existing] } = await query(
        `SELECT * FROM drive_files WHERE id = $1`, [file_id]);
      if (!existing) return res.status(404).json({ error: 'File not found' });

      const role = await getEffectiveRole(req.userId, 'file', file_id);
      if (!hasRole(role, 'editor')) return res.status(403).json({ error: 'No permission' });

      if (expected_version && existing.version !== parseInt(expected_version)) {
        return res.status(409).json({
          error: 'Conflict: file has been modified',
          server_version: existing.version,
          client_version: parseInt(expected_version)
        });
      }

      // Delete old Cloudinary asset
      if (existing.cloudinary_id) {
        try { await cloudinary.uploader.destroy(existing.cloudinary_id, { resource_type: 'raw' }); } catch {
          try { await cloudinary.uploader.destroy(existing.cloudinary_id); } catch {}
        }
      }

      const cloudFolder = existing.folder_id
        ? `propspot/drive/${existing.folder_id}`
        : 'propspot/drive/root';
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { resource_type: 'auto', folder: cloudFolder },
          (err, out) => err ? reject(err) : resolve(out)
        ).end(req.file.buffer);
      });

      const { rows: [file] } = await query(`
        UPDATE drive_files SET
          url = $2, cloudinary_id = $3, mime_type = $4, size_bytes = $5,
          content_hash = $6, version = version + 1, updated_at = NOW()
        WHERE id = $1 RETURNING *
      `, [file_id, result.secure_url, result.public_id,
          req.file.mimetype || null, req.file.size || null, contentHash]);

      return res.json(file);
    }

    // New file upload
    if (folder_id) {
      const role = await getEffectiveRole(req.userId, 'folder', folder_id);
      if (!hasRole(role, 'editor')) return res.status(403).json({ error: 'No permission' });
    }

    const cloudFolder = folder_id ? `propspot/drive/${folder_id}` : 'propspot/drive/root';
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'auto', folder: cloudFolder },
        (err, out) => err ? reject(err) : resolve(out)
      ).end(req.file.buffer);
    });

    const { rows: [file] } = await query(`
      INSERT INTO drive_files (folder_id, property_id, filename, url, cloudinary_id,
                               mime_type, size_bytes, uploaded_by, drive_type, content_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [folder_id || null, property_id || null, req.file.originalname || 'upload',
        result.secure_url, result.public_id, req.file.mimetype || null,
        req.file.size || null, req.userId, drive_type || 'shared', contentHash]);

    res.status(201).json(file);
  } catch (err) {
    console.error('sync upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// ── DELETE /api/drive/sync/file/:fileId ───────────────────────────
// Delete with tombstone creation for sync propagation
router.delete('/file/:fileId', async (req, res) => {
  try {
    const { rows: [file] } = await query(
      `SELECT * FROM drive_files WHERE id = $1`, [req.params.fileId]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const role = await getEffectiveRole(req.userId, 'file', file.id);
    if (!hasRole(role, 'editor')) return res.status(403).json({ error: 'No permission' });

    if (file.cloudinary_id) {
      try { await cloudinary.uploader.destroy(file.cloudinary_id, { resource_type: 'raw' }); } catch {
        try { await cloudinary.uploader.destroy(file.cloudinary_id); } catch {}
      }
    }

    await query(`
      INSERT INTO drive_sync_tombstones (item_type, item_id, parent_id, filename, deleted_by)
      VALUES ('file', $1, $2, $3, $4)
    `, [file.id, file.folder_id, file.filename, req.userId]);

    await query(`DELETE FROM drive_files WHERE id = $1`, [file.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('sync delete error:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ── GET /api/drive/sync/devices ───────────────────────────────────
// List sync devices for current user
router.get('/devices', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM drive_sync_cursors
       WHERE user_id = $1
       ORDER BY last_seen DESC
    `, [req.userId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list devices' });
  }
});

// ── DELETE /api/drive/sync/devices/:deviceId ──────────────────────
router.delete('/devices/:deviceId', async (req, res) => {
  try {
    await query(`
      DELETE FROM drive_sync_cursors
       WHERE user_id = $1 AND device_id = $2
    `, [req.userId, req.params.deviceId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove device' });
  }
});

module.exports = router;
