const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chokidar = require('chokidar');

class SyncEngine {
  constructor({ apiClient, syncFolder, deviceId, store, onStatusChange }) {
    this.api = apiClient;
    this.syncFolder = syncFolder;
    this.deviceId = deviceId;
    this.store = store;
    this.onStatusChange = onStatusChange || (() => {});

    this.status = 'idle';
    this.cursor = store.get('syncCursor') || null;
    this.syncInterval = store.get('syncInterval') || 30000;
    this.timer = null;
    this.watcher = null;
    this.paused = false;
    this.syncing = false;

    // Maps remote IDs to local paths and vice versa
    this.remoteToLocal = new Map(); // fileId -> localPath
    this.localToRemote = new Map(); // localPath -> { id, version, hash }
    this.folderMap = new Map();     // folderId -> localDirPath

    // Debounce local changes to avoid uploading mid-save
    this.pendingLocalChanges = new Map();
    this.localChangeDelay = 2000;
  }

  async start() {
    this.setStatus('syncing');

    try {
      // Initial full sync if no cursor
      if (!this.cursor) {
        await this.fullSync();
      } else {
        await this.deltaSync();
      }

      this.startWatcher();
      this.startPolling();
      this.setStatus('idle');
    } catch (err) {
      console.error('Sync start error:', err);
      this.setStatus('error');
      // Retry in 10 seconds
      setTimeout(() => this.start(), 10000);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.watcher) this.watcher.close();
    this.timer = null;
    this.watcher = null;
  }

  pause() {
    this.paused = true;
    this.setStatus('idle');
  }

  resume() {
    this.paused = false;
    this.syncNow();
  }

  setSyncInterval(ms) {
    this.syncInterval = ms;
    if (this.timer) {
      clearInterval(this.timer);
      this.startPolling();
    }
  }

  async syncNow() {
    if (this.paused || this.syncing) return;
    this.syncing = true;
    this.setStatus('syncing');
    try {
      await this.deltaSync();
      this.setStatus('idle');
    } catch (err) {
      console.error('Sync error:', err);
      this.setStatus('error');
    } finally {
      this.syncing = false;
    }
  }

  getStatus() {
    return {
      status: this.status,
      syncFolder: this.syncFolder,
      filesTracked: this.remoteToLocal.size,
      foldersTracked: this.folderMap.size,
      lastSync: this.cursor
    };
  }

  setStatus(status) {
    this.status = status;
    this.onStatusChange(status);
  }

  // ── Full Sync (initial) ─────────────────────────────────────────

  async fullSync() {
    const tree = await this.api.getFullTree();

    // Create folder structure
    const folderIdToPath = new Map();
    const rootFolders = tree.folders.filter(f => !f.parent_id);
    const childFolders = tree.folders.filter(f => f.parent_id);

    for (const folder of rootFolders) {
      const dirPath = path.join(this.syncFolder, sanitizeName(folder.name));
      ensureDir(dirPath);
      folderIdToPath.set(folder.id, dirPath);
      this.folderMap.set(folder.id, dirPath);
    }

    // Resolve children iteratively (handles arbitrarily deep nesting)
    let remaining = [...childFolders];
    let maxPasses = 20;
    while (remaining.length > 0 && maxPasses-- > 0) {
      const next = [];
      for (const folder of remaining) {
        const parentPath = folderIdToPath.get(folder.parent_id);
        if (parentPath) {
          const dirPath = path.join(parentPath, sanitizeName(folder.name));
          ensureDir(dirPath);
          folderIdToPath.set(folder.id, dirPath);
          this.folderMap.set(folder.id, dirPath);
        } else {
          next.push(folder);
        }
      }
      remaining = next;
    }

    // Download files
    for (const file of tree.files) {
      const parentDir = file.folder_id
        ? (folderIdToPath.get(file.folder_id) || this.syncFolder)
        : this.syncFolder;
      const localPath = path.join(parentDir, sanitizeName(file.filename));

      // Skip if local file exists with same hash
      if (fs.existsSync(localPath) && file.content_hash) {
        const localHash = hashFile(localPath);
        if (localHash === file.content_hash) {
          this.trackFile(file.id, localPath, file.version, file.content_hash);
          continue;
        }
      }

      try {
        await this.api.downloadFile(file.id, localPath);
        this.trackFile(file.id, localPath, file.version, file.content_hash);
      } catch (err) {
        console.error(`Failed to download ${file.filename}:`, err.message);
      }
    }

    this.cursor = tree.cursor;
    this.store.set('syncCursor', this.cursor);
  }

  // ── Delta Sync ──────────────────────────────────────────────────

  async deltaSync() {
    if (!this.cursor) return this.fullSync();

    const changes = await this.api.getChanges(this.cursor, this.deviceId);

    // Process folder changes
    for (const folder of changes.folders) {
      const parentPath = folder.parent_id
        ? (this.folderMap.get(folder.parent_id) || this.syncFolder)
        : this.syncFolder;
      const dirPath = path.join(parentPath, sanitizeName(folder.name));
      ensureDir(dirPath);
      this.folderMap.set(folder.id, dirPath);
    }

    // Process file changes
    for (const file of changes.files) {
      const existingPath = this.remoteToLocal.get(file.id);
      const parentDir = file.folder_id
        ? (this.folderMap.get(file.folder_id) || this.syncFolder)
        : this.syncFolder;
      const localPath = path.join(parentDir, sanitizeName(file.filename));

      // If file moved or renamed, move locally
      if (existingPath && existingPath !== localPath) {
        try {
          if (fs.existsSync(existingPath)) {
            ensureDir(path.dirname(localPath));
            fs.renameSync(existingPath, localPath);
          }
          this.untrackFile(existingPath);
        } catch (err) {
          console.error(`Failed to move ${existingPath}:`, err.message);
        }
      }

      // Check if we need to download
      const tracked = this.localToRemote.get(localPath);
      if (tracked && tracked.version >= file.version) continue;

      try {
        await this.api.downloadFile(file.id, localPath);
        this.trackFile(file.id, localPath, file.version, file.content_hash);
      } catch (err) {
        console.error(`Failed to sync ${file.filename}:`, err.message);
      }
    }

    // Process deletions
    for (const tombstone of changes.deleted) {
      if (tombstone.item_type === 'file') {
        const localPath = this.remoteToLocal.get(tombstone.item_id);
        if (localPath && fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
          this.untrackFile(localPath);
        }
      } else if (tombstone.item_type === 'folder') {
        const dirPath = this.folderMap.get(tombstone.item_id);
        if (dirPath && fs.existsSync(dirPath)) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          this.folderMap.delete(tombstone.item_id);
        }
      }
    }

    this.cursor = changes.cursor;
    this.store.set('syncCursor', this.cursor);
  }

  // ── File Watcher (local changes) ────────────────────────────────

  startWatcher() {
    this.watcher = chokidar.watch(this.syncFolder, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
      ignored: [
        /(^|[\/\\])\../, // hidden files
        /~\$/,           // Office lock files
        /\.tmp$/
      ]
    });

    this.watcher.on('add', (filePath) => this.handleLocalChange('add', filePath));
    this.watcher.on('change', (filePath) => this.handleLocalChange('change', filePath));
    this.watcher.on('unlink', (filePath) => this.handleLocalDelete(filePath));
    this.watcher.on('addDir', (dirPath) => this.handleLocalDirAdd(dirPath));
    this.watcher.on('unlinkDir', (dirPath) => this.handleLocalDirDelete(dirPath));
  }

  handleLocalChange(event, filePath) {
    if (this.paused) return;

    // Debounce: wait for file to stabilize
    if (this.pendingLocalChanges.has(filePath)) {
      clearTimeout(this.pendingLocalChanges.get(filePath));
    }

    this.pendingLocalChanges.set(filePath, setTimeout(async () => {
      this.pendingLocalChanges.delete(filePath);
      try {
        await this.uploadLocalFile(filePath);
      } catch (err) {
        console.error(`Failed to upload ${filePath}:`, err.message);
      }
    }, this.localChangeDelay));
  }

  async uploadLocalFile(filePath) {
    if (!fs.existsSync(filePath)) return;

    const tracked = this.localToRemote.get(filePath);
    const folderId = this.findFolderIdForPath(filePath);

    if (tracked) {
      // Update existing file
      const result = await this.api.uploadFile(
        filePath, folderId, tracked.id, tracked.version);
      this.trackFile(result.id, filePath, result.version, result.content_hash);
    } else {
      // New file
      const result = await this.api.uploadFile(filePath, folderId);
      this.trackFile(result.id, filePath, result.version, result.content_hash);
    }
  }

  async handleLocalDelete(filePath) {
    const tracked = this.localToRemote.get(filePath);
    if (!tracked) return;

    try {
      await this.api.deleteFile(tracked.id);
      this.untrackFile(filePath);
    } catch (err) {
      console.error(`Failed to delete remote file for ${filePath}:`, err.message);
    }
  }

  async handleLocalDirAdd(dirPath) {
    if (dirPath === this.syncFolder) return;
    // Don't auto-create remote folders for every directory;
    // they'll be created on first file upload if needed
  }

  async handleLocalDirDelete(dirPath) {
    // Find remote folder and delete it
    for (const [folderId, localDir] of this.folderMap) {
      if (localDir === dirPath) {
        // Remote deletion happens through the web UI; local-only
        // directory removal just removes our tracking
        this.folderMap.delete(folderId);
        break;
      }
    }
  }

  // ── Tracking helpers ────────────────────────────────────────────

  trackFile(id, localPath, version, hash) {
    this.remoteToLocal.set(id, localPath);
    this.localToRemote.set(localPath, { id, version, hash });
  }

  untrackFile(localPath) {
    const tracked = this.localToRemote.get(localPath);
    if (tracked) {
      this.remoteToLocal.delete(tracked.id);
      this.localToRemote.delete(localPath);
    }
  }

  findFolderIdForPath(filePath) {
    const dir = path.dirname(filePath);
    for (const [folderId, folderPath] of this.folderMap) {
      if (folderPath === dir) return folderId;
    }
    return null;
  }

  // ── Polling ─────────────────────────────────────────────────────

  startPolling() {
    this.timer = setInterval(() => this.syncNow(), this.syncInterval);
  }
}

// ── Utilities ────────────────────────────────────────────────────

function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(data).digest('hex');
}

module.exports = SyncEngine;
