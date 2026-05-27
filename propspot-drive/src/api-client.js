const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

class ApiClient {
  constructor(serverUrl, token) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.token = token;
  }

  setToken(token) {
    this.token = token;
  }

  headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };
  }

  async request(method, endpoint, body) {
    const url = `${this.serverUrl}${endpoint}`;
    const opts = {
      method,
      headers: this.headers(),
    };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // ── Auth ───────────────────────────────────────────────────────
  async login(email, password) {
    const res = await fetch(`${this.serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Login failed');
    }
    return res.json();
  }

  // ── Sync API ───────────────────────────────────────────────────
  async registerDevice(deviceId, deviceName, platform) {
    return this.request('POST', '/api/drive/sync/register-device', {
      device_id: deviceId,
      device_name: deviceName,
      platform
    });
  }

  async getSyncStatus() {
    return this.request('GET', '/api/drive/sync/status');
  }

  async getFullTree(driveType) {
    const qs = driveType ? `?drive_type=${driveType}` : '';
    return this.request('GET', `/api/drive/sync/tree${qs}`);
  }

  async getChanges(cursor, deviceId) {
    return this.request('GET',
      `/api/drive/sync/changes?cursor=${encodeURIComponent(cursor)}&device_id=${encodeURIComponent(deviceId)}`);
  }

  async downloadFile(fileId, destPath) {
    const url = `${this.serverUrl}/api/drive/sync/download/${fileId}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${this.token}` }});
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

    return new Promise((resolve, reject) => {
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const fileStream = fs.createWriteStream(destPath);
      res.body.pipe(fileStream);
      res.body.on('error', reject);
      fileStream.on('finish', resolve);
    });
  }

  async uploadFile(localPath, folderId, fileId, expectedVersion) {
    const url = `${this.serverUrl}/api/drive/sync/upload`;
    const form = new FormData();
    form.append('file', fs.createReadStream(localPath), path.basename(localPath));
    if (folderId) form.append('folder_id', folderId);
    if (fileId) form.append('file_id', fileId);
    if (expectedVersion) form.append('expected_version', String(expectedVersion));

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` },
      body: form
    });

    if (res.status === 409) {
      const conflict = await res.json();
      throw Object.assign(new Error('Conflict'), { conflict: true, details: conflict });
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Upload failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  async deleteFile(fileId) {
    return this.request('DELETE', `/api/drive/sync/file/${fileId}`);
  }

  // ── Folder operations ──────────────────────────────────────────
  async createFolder(name, parentId) {
    return this.request('POST', '/api/drive/folders', {
      name, parent_id: parentId || null
    });
  }
}

module.exports = ApiClient;
