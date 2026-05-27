const process = require('process');

function setupPlatformIntegration(syncFolder) {
  switch (process.platform) {
    case 'darwin':
      return require('./macos').setup(syncFolder);
    case 'win32':
      return require('./windows').setup(syncFolder);
    default:
      return require('./linux').setup(syncFolder);
  }
}

function removePlatformIntegration() {
  switch (process.platform) {
    case 'darwin':
      return require('./macos').remove();
    case 'win32':
      return require('./windows').remove();
    default:
      return require('./linux').remove();
  }
}

module.exports = { setupPlatformIntegration, removePlatformIntegration };
