const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { pctToPdfRect } = require('./inkd-pdf-coords');

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  const ab = await r.arrayBuffer();
  return new Uint8Array(ab);
}

// Flatten field_values onto a PDF + append a certificate page.
// Returns { bytes: Uint8Array, hash: hex string }
async function buildSignedPdf({ sourcePdfUrl, envelope, recipients, fieldValues, auditEvents }) {
  const srcBytes = await fetchBytes(sourcePdfUrl);
  const pdf = await PDFDocument.load(srcBytes);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Group field values by page
  const byPage = new Map();
  for (const fv of fieldValues) {
    if (!byPage.has(fv.page_number)) byPage.set(fv.page_number, []);
    byPage.get(fv.page_number).push(fv);
  }

  const pages = pdf.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const { width: pw, height: ph } = page.getSize();
    const fields = byPage.get(i + 1) || [];
    for (const fv of fields) {
      const r = pctToPdfRect(fv, pw, ph);
      const v = fv.value;
      if (v == null || v === '') continue;
      if (fv.field_type === 'text') {
        page.drawText(String(v), {
          x: r.x + 2, y: r.y + 4, size: Math.min(r.height - 4, 11), font: helv, color: rgb(0,0,0),
        });
      } else if (fv.field_type === 'date') {
        page.drawText(String(v), { x: r.x + 2, y: r.y + 4, size: 11, font: helv, color: rgb(0,0,0) });
      } else if (fv.field_type === 'checkbox') {
        if (String(v) === 'true') {
          page.drawText('X', { x: r.x + 2, y: r.y + 2, size: r.height - 2, font: helvBold, color: rgb(0,0,0) });
        }
      } else if (fv.field_type === 'signature' || fv.field_type === 'initial') {
        try {
          const imgBytes = await fetchBytes(String(v));
          const img = await pdf.embedPng(imgBytes);
          page.drawImage(img, { x: r.x, y: r.y, width: r.width, height: r.height });
        } catch (e) {
          page.drawText('(signature)', { x: r.x, y: r.y, size: 10, font: helv, color: rgb(0,0,0) });
        }
      }
    }
  }

  // Append certificate page(s)
  let certPage = pdf.addPage([612, 792]); // US Letter
  let cy = 750;
  certPage.drawText('Certificate of Completion', { x: 50, y: cy, size: 18, font: helvBold });
  cy -= 28;
  certPage.drawText(`Envelope: ${envelope.name}`, { x: 50, y: cy, size: 11, font: helv });
  cy -= 16;
  certPage.drawText(`Envelope ID: ${envelope.id}`, { x: 50, y: cy, size: 10, font: helv });
  cy -= 14;
  certPage.drawText(`Created: ${new Date(envelope.created_at).toISOString()}`, { x: 50, y: cy, size: 10, font: helv });
  cy -= 14;
  certPage.drawText(`Completed: ${new Date(envelope.completed_at || Date.now()).toISOString()}`, { x: 50, y: cy, size: 10, font: helv });
  cy -= 28;

  certPage.drawText('Signers', { x: 50, y: cy, size: 14, font: helvBold });
  cy -= 18;
  for (const r of recipients) {
    if (cy < 80) { certPage = pdf.addPage([612, 792]); cy = 750; }
    certPage.drawText(`• ${r.full_name} (${r.role}) — ${r.email}`, { x: 50, y: cy, size: 10, font: helv });
    cy -= 12;
    certPage.drawText(`  Signed at ${r.signed_at ? new Date(r.signed_at).toISOString() : '—'} from ${r.signed_ip || '—'}`,
                      { x: 50, y: cy, size: 9, font: helv, color: rgb(.3,.3,.3) });
    cy -= 14;
  }

  cy -= 14;
  if (cy < 100) { certPage = pdf.addPage([612, 792]); cy = 750; }
  certPage.drawText('Audit trail', { x: 50, y: cy, size: 14, font: helvBold });
  cy -= 18;
  for (const ev of auditEvents) {
    if (cy < 60) { certPage = pdf.addPage([612, 792]); cy = 750; }
    const ts = new Date(ev.event_at).toISOString();
    const line = `${ts}  ${ev.event_type}${ev.recipient_id ? ' (recipient)' : ''}${ev.ip ? '  ip=' + ev.ip : ''}`;
    certPage.drawText(line, { x: 50, y: cy, size: 9, font: helv });
    cy -= 11;
  }

  cy -= 14;
  if (cy < 40) { certPage = pdf.addPage([612, 792]); cy = 750; }
  certPage.drawText('Hash (SHA-256 of full document): stored on the PropSpot envelope record',
                    { x: 50, y: cy, size: 9, font: helv });

  const bytes = await pdf.save();
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return { bytes, hash };
}

module.exports = { buildSignedPdf };
