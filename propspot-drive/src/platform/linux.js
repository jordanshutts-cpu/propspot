const fs = require('fs');
const path = require('path');

// Linux: add bookmark to file manager sidebar (GTK/GNOME, KDE)

function setup(syncFolder) {
  try {
    addGtkBookmark(syncFolder);
  } catch (err) {
    console.error('Linux integration error:', err.message);
  }
}

function remove() {
  try {
    removeGtkBookmark();
  } catch {}
}

function addGtkBookmark(syncFolder) {
  const bookmarksPath = path.join(process.env.HOME, '.config', 'gtk-3.0', 'bookmarks');
  const entry = `file://${syncFolder} PropSpot Drive`;

  let contents = '';
  if (fs.existsSync(bookmarksPath)) {
    contents = fs.readFileSync(bookmarksPath, 'utf8');
    if (contents.includes('PropSpot Drive')) return;
  }

  const dir = path.dirname(bookmarksPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bookmarksPath, contents.trimEnd() + '\n' + entry + '\n');
}

function removeGtkBookmark() {
  const bookmarksPath = path.join(process.env.HOME, '.config', 'gtk-3.0', 'bookmarks');
  if (!fs.existsSync(bookmarksPath)) return;

  const lines = fs.readFileSync(bookmarksPath, 'utf8')
    .split('\n')
    .filter(line => !line.includes('PropSpot Drive'));
  fs.writeFileSync(bookmarksPath, lines.join('\n'));
}

module.exports = { setup, remove };
