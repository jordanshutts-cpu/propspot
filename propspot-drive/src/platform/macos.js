const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// macOS integration: adds PropSpot Drive to Finder sidebar
// and registers a Finder Sync Extension placeholder.
//
// Full File Provider Extension (like OneDrive/Dropbox) requires a native
// Swift/Obj-C extension bundled in the .app. This module handles the
// Electron-side setup; the native extension lives in the Xcode project
// at build/macos/PropSpotFileProvider/.

function setup(syncFolder) {
  try {
    addToFinderSidebar(syncFolder);
    setFolderIcon(syncFolder);
    registerWithLaunchServices();
  } catch (err) {
    console.error('macOS integration error:', err.message);
  }
}

function remove() {
  try {
    removeFromFinderSidebar();
  } catch (err) {
    console.error('macOS remove error:', err.message);
  }
}

function addToFinderSidebar(syncFolder) {
  // Use the SharedFileList API via osascript to add to Finder sidebar.
  // This places "PropSpot Drive" alongside iCloud Drive, Dropbox, etc.
  const script = `
    tell application "Finder"
      try
        make new item at favorites with properties {path:"${syncFolder}"}
      end try
    end tell
  `;
  try {
    execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 5000 });
  } catch {
    // Fallback: create a symlink in the sidebar-friendly location
    const sidebarLink = path.join(
      process.env.HOME, 'Library', 'CloudStorage', 'PropSpot Drive');
    if (!fs.existsSync(sidebarLink)) {
      try {
        // CloudStorage is where macOS shows cloud provider folders in
        // Finder sidebar automatically (Sonoma+). Creating a directory
        // or symlink here makes it appear alongside iCloud/OneDrive.
        const cloudStorageDir = path.join(process.env.HOME, 'Library', 'CloudStorage');
        if (!fs.existsSync(cloudStorageDir)) {
          fs.mkdirSync(cloudStorageDir, { recursive: true });
        }
        fs.symlinkSync(syncFolder, sidebarLink);
      } catch (err) {
        console.error('Could not create CloudStorage symlink:', err.message);
      }
    }
  }
}

function removeFromFinderSidebar() {
  const sidebarLink = path.join(
    process.env.HOME, 'Library', 'CloudStorage', 'PropSpot Drive');
  if (fs.existsSync(sidebarLink) && fs.lstatSync(sidebarLink).isSymbolicLink()) {
    fs.unlinkSync(sidebarLink);
  }
}

function setFolderIcon(syncFolder) {
  // Set a custom folder icon using iconutil (if icon asset exists)
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'folder-icon.icns');
  if (!fs.existsSync(iconPath)) return;

  try {
    // Copy icon to the folder's Icon\r file (macOS custom icon convention)
    const iconDest = path.join(syncFolder, 'Icon\r');
    fs.copyFileSync(iconPath, iconDest);
    execSync(`SetFile -a C "${syncFolder}"`, { timeout: 5000 });
    execSync(`SetFile -a V "${iconDest}"`, { timeout: 5000 });
  } catch {
    // SetFile may not be available without Xcode CLI tools
  }
}

function registerWithLaunchServices() {
  // Register the app as a cloud storage provider.
  // Full registration requires the File Provider Extension to be bundled
  // in the signed .app — this is set up at build time via Xcode.
}

module.exports = { setup, remove };
