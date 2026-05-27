const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Windows integration: registers PropSpot Drive as a Cloud Storage Provider
// using Shell Namespace Extensions and the Cloud Files API.
//
// The full Cloud Files (cfapi.h) integration requires a native C++ module
// that implements IStorageProviderHandler. This module handles the
// Electron-side setup for Quick Access pinning and shell integration.
// The native companion is built at build time via the MSVC project in
// build/windows/PropSpotCloudProvider/.

function setup(syncFolder) {
  try {
    pinToQuickAccess(syncFolder);
    registerCloudProvider(syncFolder);
    addToNavigationPane(syncFolder);
  } catch (err) {
    console.error('Windows integration error:', err.message);
  }
}

function remove() {
  try {
    unregisterCloudProvider();
  } catch {
    // Best-effort cleanup
  }
}

function pinToQuickAccess(syncFolder) {
  // Pin the sync folder to Quick Access in File Explorer.
  // This makes it visible in Save As / Open dialogs immediately.
  const ps = `
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.Namespace("${syncFolder.replace(/\\/g, '\\\\')}")
    if ($folder) {
      $folder.Self.InvokeVerb("pintohome")
    }
  `;
  try {
    execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
      timeout: 10000,
      windowsHide: true
    });
  } catch (err) {
    console.error('Quick Access pin failed:', err.message);
  }
}

function registerCloudProvider(syncFolder) {
  // Register as a Cloud Storage Provider in the Windows registry.
  // This adds "PropSpot Drive" to the left sidebar of File Explorer
  // alongside OneDrive, Google Drive, etc.
  //
  // Registry path: HKCU\Software\Classes\CLSID\{<GUID>}
  // and HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace\{<GUID>}
  const CLSID = '{B5E6A2C1-4F3D-4A7E-9D8C-1F2E3A4B5C6D}';

  const regCommands = [
    // Register CLSID
    `reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}" /ve /d "PropSpot Drive" /f`,
    `reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}" /v "System.IsPinnedToNameSpaceTree" /t REG_DWORD /d 1 /f`,
    `reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}" /v "SortOrderIndex" /t REG_DWORD /d 66 /f`,
    `reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}\\DefaultIcon" /ve /d "${path.join(__dirname, '..', '..', 'assets', 'icon.ico')}" /f`,
    `reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}\\InProcServer32" /ve /d "%SystemRoot%\\system32\\shell32.dll" /f`,
    `reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}\\Instance" /v "CLSID" /d "{0E5AAE11-A475-4c5b-AB00-C66DE400274E}" /f`,
    `reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}\\Instance\\InitPropertyBag" /v "Attributes" /t REG_DWORD /d 17 /f`,
    `reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}\\Instance\\InitPropertyBag" /v "TargetFolderPath" /d "${syncFolder}" /f`,
    `reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}\\ShellFolder" /v "FolderValueFlags" /t REG_DWORD /d 40 /f`,
    `reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}\\ShellFolder" /v "Attributes" /t REG_DWORD /d 4034920525 /f`,
    // Add to namespace
    `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Desktop\\NameSpace\\${CLSID}" /ve /d "PropSpot Drive" /f`,
    // Hide from Desktop
    `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\HideDesktopIcons\\NewStartPanel" /v "${CLSID}" /t REG_DWORD /d 1 /f`
  ];

  for (const cmd of regCommands) {
    try {
      execSync(cmd, { timeout: 5000, windowsHide: true });
    } catch (err) {
      console.error('Registry command failed:', cmd, err.message);
    }
  }
}

function unregisterCloudProvider() {
  const CLSID = '{B5E6A2C1-4F3D-4A7E-9D8C-1F2E3A4B5C6D}';
  const cmds = [
    `reg delete "HKCU\\Software\\Classes\\CLSID\\${CLSID}" /f`,
    `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Desktop\\NameSpace\\${CLSID}" /f`,
    `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\HideDesktopIcons\\NewStartPanel" /v "${CLSID}" /f`
  ];
  for (const cmd of cmds) {
    try { execSync(cmd, { timeout: 5000, windowsHide: true }); } catch {}
  }
}

function addToNavigationPane(syncFolder) {
  // The registry entries above should add it to the nav pane.
  // Restart Explorer to apply (user sees it after restart or next login).
  // We don't force-restart Explorer here to avoid disruption.
}

module.exports = { setup, remove };
