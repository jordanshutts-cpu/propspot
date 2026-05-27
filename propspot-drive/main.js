const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const SyncEngine = require('./src/sync-engine');
const ApiClient = require('./src/api-client');
const { setupPlatformIntegration, removePlatformIntegration } = require('./src/platform');

const store = new Store({
  defaults: {
    serverUrl: '',
    token: null,
    syncFolder: path.join(app.getPath('home'), 'PropSpot Drive'),
    deviceId: null,
    syncInterval: 30000
  }
});

let mainWindow = null;
let tray = null;
let syncEngine = null;
let apiClient = null;

function getDeviceId() {
  let deviceId = store.get('deviceId');
  if (!deviceId) {
    deviceId = `${process.platform}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    store.set('deviceId', deviceId);
  }
  return deviceId;
}

function createLoginWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 520,
    resizable: false,
    frame: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'ui', 'login.html'));
}

function createSettingsWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 600,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'ui', 'settings.html'));
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  updateTrayMenu('idle');
}

function updateTrayMenu(status) {
  const statusLabels = {
    idle: 'Up to date',
    syncing: 'Syncing...',
    error: 'Sync error',
    offline: 'Offline'
  };

  const contextMenu = Menu.buildFromTemplate([
    { label: `PropSpot Drive — ${statusLabels[status] || status}`, enabled: false },
    { type: 'separator' },
    { label: 'Open PropSpot Drive Folder', click: () => {
      shell.openPath(store.get('syncFolder'));
    }},
    { label: 'Open PropSpot Web', click: () => {
      shell.openExternal(store.get('serverUrl'));
    }},
    { type: 'separator' },
    { label: 'Sync Now', click: () => {
      if (syncEngine) syncEngine.syncNow();
    }},
    { label: 'Pause Sync', type: 'checkbox', checked: false, click: (item) => {
      if (syncEngine) {
        if (item.checked) syncEngine.pause();
        else syncEngine.resume();
      }
    }},
    { type: 'separator' },
    { label: 'Settings...', click: () => createSettingsWindow() },
    { label: 'Sign Out', click: signOut },
    { type: 'separator' },
    { label: 'Quit PropSpot Drive', click: () => app.quit() }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(`PropSpot Drive — ${statusLabels[status]}`);
}

async function startSync() {
  const token = store.get('token');
  const serverUrl = store.get('serverUrl');
  const syncFolder = store.get('syncFolder');

  if (!token || !serverUrl) return;

  if (!fs.existsSync(syncFolder)) {
    fs.mkdirSync(syncFolder, { recursive: true });
  }

  apiClient = new ApiClient(serverUrl, token);

  syncEngine = new SyncEngine({
    apiClient,
    syncFolder,
    deviceId: getDeviceId(),
    store,
    onStatusChange: (status) => {
      if (tray) updateTrayMenu(status);
    }
  });

  await syncEngine.start();

  setupPlatformIntegration(syncFolder);
}

function signOut() {
  if (syncEngine) {
    syncEngine.stop();
    syncEngine = null;
  }
  removePlatformIntegration();
  store.delete('token');
  createLoginWindow();
}

// ── IPC Handlers ──────────────────────────────────────────────────

ipcMain.handle('login', async (event, { serverUrl, email, password }) => {
  try {
    const client = new ApiClient(serverUrl, null);
    const result = await client.login(email, password);
    store.set('serverUrl', serverUrl);
    store.set('token', result.token);

    await client.setToken(result.token);
    await client.registerDevice(getDeviceId(), require('os').hostname(), process.platform);

    if (mainWindow) {
      mainWindow.close();
      mainWindow = null;
    }

    await startSync();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-settings', () => ({
  serverUrl: store.get('serverUrl'),
  syncFolder: store.get('syncFolder'),
  syncInterval: store.get('syncInterval'),
  deviceId: store.get('deviceId')
}));

ipcMain.handle('update-settings', async (event, settings) => {
  if (settings.syncFolder && settings.syncFolder !== store.get('syncFolder')) {
    const oldFolder = store.get('syncFolder');
    store.set('syncFolder', settings.syncFolder);
    if (syncEngine) {
      syncEngine.stop();
      await startSync();
    }
  }
  if (settings.syncInterval) {
    store.set('syncInterval', settings.syncInterval);
    if (syncEngine) syncEngine.setSyncInterval(settings.syncInterval);
  }
  return { success: true };
});

ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Choose PropSpot Drive folder location'
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-sync-status', () => {
  if (!syncEngine) return { status: 'disconnected' };
  return syncEngine.getStatus();
});

// ── App Lifecycle ─────────────────────────────────────────────────

app.on('ready', async () => {
  createTray();

  if (store.get('token') && store.get('serverUrl')) {
    await startSync();
  } else {
    createLoginWindow();
  }
});

app.on('window-all-closed', (e) => {
  // Keep running in tray on macOS
  if (process.platform !== 'darwin') {
    // On Windows/Linux, keep in tray too
  }
});

app.on('before-quit', () => {
  if (syncEngine) syncEngine.stop();
});

// Keep a single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
