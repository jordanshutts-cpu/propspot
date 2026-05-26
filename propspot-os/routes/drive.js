const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── Permission helper ────────────────────────────────────────────────
// Walks up the folder tree to find effective permission.
// Owners/admins always get 'owner'. team_visible grants implicit 'viewer'.
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

// ── Folders ──────────────────────────────────────────────────────────

// GET /api/drive/folders?parent_id=&property_id=
router.get('/folders', async (req, res) => {
  try {
    const { parent_id, property_id } = req.query;
    let sql = `
      SELECT f.*, u.full_name AS created_by_name,
             (SELECT COUNT(*)::int FROM drive_folders WHERE parent_id = f.id) AS subfolder_count,
             (SELECT COUNT(*)::int FROM drive_files WHERE folder_id = f.id) AS file_count
        FROM drive_folders f
        LEFT JOIN users u ON u.id = f.created_by
       WHERE 1=1
    `;
    const params = [];
    if (parent_id) {
      params.push(parent_id);
      sql += ` AND f.parent_id = $${params.length}`;
    } else if (!property_id) {
      sql += ` AND f.parent_id IS NULL`;
    }
    if (property_id) {
      params.push(property_id);
      sql += ` AND f.property_id = $${params.length}`;
    }
    sql += ` ORDER BY f.name`;
    const { rows } = await query(sql, params);
    const visible = [];
    for (const folder of rows) {
      if (folder.team_visible || folder.created_by === req.userId) {
        visible.push(folder);
      } else {
        const role = await getEffectiveRole(req.userId, 'folder', folder.id);
        if (role) visible.push(folder);
      }
    }
    res.json(visible);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list folders' });
  }
});

// GET /api/drive/folders/:id — single folder with breadcrumb
router.get('/folders/:id', async (req, res) => {
  try {
    const { rows: [folder] } = await query(`
      SELECT f.*, u.full_name AS created_by_name
        FROM drive_folders f LEFT JOIN users u ON u.id = f.created_by
       WHERE f.id = $1
    `, [req.params.id]);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    // Build breadcrumb
    const breadcrumb = [{ id: folder.id, name: folder.name }];
    let pid = folder.parent_id;
    while (pid) {
      const { rows: [p] } = await query(`SELECT id, name, parent_id FROM drive_folders WHERE id = $1`, [pid]);
      if (!p) break;
      breadcrumb.unshift({ id: p.id, name: p.name });
      pid = p.parent_id;
    }
    folder.breadcrumb = breadcrumb;
    res.json(folder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get folder' });
  }
});

// POST /api/drive/folders
router.post('/folders', async (req, res) => {
  try {
    const { name, parent_id, property_id, team_visible } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    if (parent_id) {
      const role = await getEffectiveRole(req.userId, 'folder', parent_id);
      if (!hasRole(role, 'editor')) return res.status(403).json({ error: 'No permission to create in this folder' });
    }

    const { rows: [folder] } = await query(`
      INSERT INTO drive_folders (name, parent_id, property_id, team_visible, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [name.trim(), parent_id || null, property_id || null, team_visible !== false, req.userId]);
    res.status(201).json(folder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

// PATCH /api/drive/folders/:id
router.patch('/folders/:id', async (req, res) => {
  try {
    const role = await getEffectiveRole(req.userId, 'folder', req.params.id);
    if (!hasRole(role, 'editor')) return res.status(403).json({ error: 'No permission' });

    const { name, parent_id, team_visible } = req.body;
    const { rows: [folder] } = await query(`
      UPDATE drive_folders SET
        name = COALESCE($2, name),
        parent_id = $3,
        team_visible = COALESCE($4, team_visible),
        updated_at = NOW()
      WHERE id = $1 RETURNING *
    `, [req.params.id, name || null, parent_id !== undefined ? parent_id : undefined, team_visible !== undefined ? team_visible : null]);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    res.json(folder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update folder' });
  }
});

// DELETE /api/drive/folders/:id
router.delete('/folders/:id', async (req, res) => {
  try {
    const role = await getEffectiveRole(req.userId, 'folder', req.params.id);
    if (!hasRole(role, 'owner')) return res.status(403).json({ error: 'Only owners can delete folders' });

    // Delete Cloudinary files recursively
    const { rows: files } = await query(`
      WITH RECURSIVE tree AS (
        SELECT id FROM drive_folders WHERE id = $1
        UNION ALL
        SELECT f.id FROM drive_folders f JOIN tree t ON f.parent_id = t.id
      )
      SELECT cloudinary_id FROM drive_files WHERE folder_id IN (SELECT id FROM tree)
    `, [req.params.id]);
    for (const f of files) {
      if (f.cloudinary_id) {
        try { await cloudinary.uploader.destroy(f.cloudinary_id, { resource_type: 'raw' }); } catch {
          try { await cloudinary.uploader.destroy(f.cloudinary_id); } catch {}
        }
      }
    }

    await query(`DELETE FROM drive_folders WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

// ── Files ────────────────────────────────────────────────────────────

// GET /api/drive/files?folder_id=&property_id=
router.get('/files', async (req, res) => {
  try {
    const { folder_id, property_id } = req.query;
    let sql = `
      SELECT f.*, u.full_name AS uploaded_by_name
        FROM drive_files f
        LEFT JOIN users u ON u.id = f.uploaded_by
       WHERE 1=1
    `;
    const params = [];
    if (folder_id) {
      params.push(folder_id);
      sql += ` AND f.folder_id = $${params.length}`;
    } else if (!property_id) {
      sql += ` AND f.folder_id IS NULL`;
    }
    if (property_id) {
      params.push(property_id);
      sql += ` AND f.property_id = $${params.length}`;
    }
    sql += ` ORDER BY f.filename`;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// POST /api/drive/files — upload
router.post('/files', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const { folder_id, property_id } = req.body;

    if (folder_id) {
      const role = await getEffectiveRole(req.userId, 'folder', folder_id);
      if (!hasRole(role, 'editor')) return res.status(403).json({ error: 'No permission to upload here' });
    }

    const cloudFolder = folder_id ? `propspot/drive/${folder_id}` : 'propspot/drive/root';
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { resource_type: 'auto', folder: cloudFolder },
        (err, out) => err ? reject(err) : resolve(out)
      ).end(req.file.buffer);
    });

    const { rows: [file] } = await query(`
      INSERT INTO drive_files (folder_id, property_id, filename, url, cloudinary_id, mime_type, size_bytes, uploaded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [folder_id || null, property_id || null, req.file.originalname || 'upload', result.secure_url, result.public_id, req.file.mimetype || null, req.file.size || null, req.userId]);

    res.status(201).json(file);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// PATCH /api/drive/files/:id — rename/move
router.patch('/files/:id', async (req, res) => {
  try {
    const role = await getEffectiveRole(req.userId, 'file', req.params.id);
    if (!hasRole(role, 'editor')) return res.status(403).json({ error: 'No permission' });
    const { filename, folder_id } = req.body;
    const { rows: [file] } = await query(`
      UPDATE drive_files SET
        filename = COALESCE($2, filename),
        folder_id = COALESCE($3, folder_id)
      WHERE id = $1 RETURNING *
    `, [req.params.id, filename || null, folder_id !== undefined ? folder_id : null]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json(file);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

// DELETE /api/drive/files/:id
router.delete('/files/:id', async (req, res) => {
  try {
    const role = await getEffectiveRole(req.userId, 'file', req.params.id);
    if (!hasRole(role, 'editor')) return res.status(403).json({ error: 'No permission' });
    const { rows: [file] } = await query(`SELECT cloudinary_id FROM drive_files WHERE id = $1`, [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.cloudinary_id) {
      try { await cloudinary.uploader.destroy(file.cloudinary_id, { resource_type: 'raw' }); } catch {
        try { await cloudinary.uploader.destroy(file.cloudinary_id); } catch {}
      }
    }
    await query(`DELETE FROM drive_files WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ── Permissions ──────────────────────────────────────────────────────

// GET /api/drive/permissions/:type/:id
router.get('/permissions/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const col = type === 'folder' ? 'folder_id' : 'file_id';
    const { rows } = await query(`
      SELECT dp.*, u.full_name AS user_name, u.email AS user_email, u.avatar_url AS user_avatar
        FROM drive_permissions dp
        JOIN users u ON u.id = dp.user_id
       WHERE dp.${col} = $1
       ORDER BY dp.role DESC, u.full_name
    `, [id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list permissions' });
  }
});

// POST /api/drive/permissions — share
router.post('/permissions', async (req, res) => {
  try {
    const { folder_id, file_id, user_id, role } = req.body;
    if (!user_id || (!folder_id && !file_id)) return res.status(400).json({ error: 'user_id and folder_id or file_id required' });
    if (!['viewer', 'editor', 'owner'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const type = folder_id ? 'folder' : 'file';
    const targetId = folder_id || file_id;
    const effective = await getEffectiveRole(req.userId, type, targetId);
    if (!hasRole(effective, 'owner')) return res.status(403).json({ error: 'Only owners can manage permissions' });

    const col = folder_id ? 'folder_id' : 'file_id';
    const { rows: [perm] } = await query(`
      INSERT INTO drive_permissions (${col}, user_id, role, created_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (${col}, user_id) WHERE ${col} IS NOT NULL
      DO UPDATE SET role = $3
      RETURNING *
    `, [targetId, user_id, role, req.userId]);

    res.status(201).json(perm);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to set permission' });
  }
});

// DELETE /api/drive/permissions/:id
router.delete('/permissions/:id', async (req, res) => {
  try {
    const { rows: [perm] } = await query(`SELECT * FROM drive_permissions WHERE id = $1`, [req.params.id]);
    if (!perm) return res.status(404).json({ error: 'Permission not found' });
    const type = perm.folder_id ? 'folder' : 'file';
    const targetId = perm.folder_id || perm.file_id;
    const effective = await getEffectiveRole(req.userId, type, targetId);
    if (!hasRole(effective, 'owner')) return res.status(403).json({ error: 'Only owners can manage permissions' });
    await query(`DELETE FROM drive_permissions WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove permission' });
  }
});

module.exports = router;
