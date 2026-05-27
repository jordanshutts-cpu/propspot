const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('propspot', {
  login: (credentials) => ipcRenderer.invoke('login', credentials),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  getSyncStatus: () => ipcRenderer.invoke('get-sync-status')
});
