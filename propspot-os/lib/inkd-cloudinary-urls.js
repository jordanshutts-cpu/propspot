// Helper for generating signed Cloudinary delivery URLs for Ink'd PDFs.
//
// Background: this Cloudinary account has an ACL ('Restricted media types'
// or similar) that denies anonymous browser delivery of PDFs even when the
// asset is uploaded with type:upload + access_mode:public. The Cloudinary
// docs' answer to that ACL is "use signed URLs" — every delivery URL
// includes an HMAC-SHA1 signature derived from the api_secret, which
// proves the request is authorized.
//
// We sign each URL fresh at read time (no DB writes, no expiry to manage)
// using the public_id we stored at upload time.
const cloudinary = require('cloudinary').v2;

// Build a signed Cloudinary URL for a 'raw' PDF asset.
// publicId is what we stored in source_pdf_id / final_pdf_id.
//
// force_version: false   — by default the SDK injects '/v1/' into the URL
//   path as a placeholder when no real version is passed, but the signature
//   is computed without it. Cloudinary then rejects the URL with 401 because
//   the signature doesn't match the path. Setting force_version: false drops
//   the '/v1/' segment entirely so the path and the signed payload align.
//
// analytics: false       — the SDK appends a '?_a=...' analytics tag after
//   the signature is computed. Some Cloudinary plans validate the full query
//   string against the signature and 401 on mismatch.
function signedRawPdfUrl(publicId) {
  if (!publicId) return null;
  return cloudinary.url(publicId, {
    resource_type: 'raw',
    type:          'upload',
    sign_url:      true,
    secure:        true,
    force_version: false,
    analytics:     false,
  });
}

// Convenience: replace source_pdf_url and final_pdf_url on an envelope or
// template row with freshly-signed versions (in-place; returns the same obj).
// Falls through silently when the corresponding *_id column is null.
function signEnvelopeUrls(env) {
  if (!env) return env;
  if (env.source_pdf_id) env.source_pdf_url = signedRawPdfUrl(env.source_pdf_id);
  if (env.final_pdf_id)  env.final_pdf_url  = signedRawPdfUrl(env.final_pdf_id);
  return env;
}

function signTemplateUrls(tpl) {
  if (!tpl) return tpl;
  if (tpl.source_pdf_id) tpl.source_pdf_url = signedRawPdfUrl(tpl.source_pdf_id);
  return tpl;
}

module.exports = { signedRawPdfUrl, signEnvelopeUrls, signTemplateUrls };
