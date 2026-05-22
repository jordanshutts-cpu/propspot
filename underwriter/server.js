/**
 * underwriter/server.js
 *
 * Lightweight redirect service for uw.propspot.io.
 * The underwriting tool now lives natively inside Prop Spot OS at
 * os.propspot.io/underwriting.html — this service just forwards traffic there
 * so existing bookmarks / Railway service stay intact.
 *
 * No database access, no external dependencies.
 */

const http = require('http');

const OS_BASE = 'https://os.propspot.io';

const server = http.createServer((req, res) => {
  // Health-check shortcut (Railway pings /)
  // Still redirect — Railway marks it healthy on any 2xx or 3xx.
  const url = new URL(req.url, 'http://localhost');
  const id  = url.searchParams.get('id');

  // Deep-link support: uw.propspot.io/?id=<deal-id>
  // → os.propspot.io/underwriting-deal.html?id=<deal-id>
  const target = id
    ? `${OS_BASE}/underwriting-deal.html?id=${encodeURIComponent(id)}`
    : `${OS_BASE}/underwriting.html`;

  res.writeHead(301, { Location: target });
  res.end();
});

const PORT = parseInt(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`Underwriter redirect listening on :${PORT}`);
  console.log(`All traffic → ${OS_BASE}/underwriting.html`);
});
