// Thin Cloudinary wrapper for Pulse chat attachments. Mirrors inbox/lib/cloudinary.js
// so message attachments and inbox attachments land in the same storage account.

const { v2: cloudinary } = require('cloudinary');

if (process.env.CLOUDINARY_URL) {
  // The SDK auto-parses CLOUDINARY_URL from the env, but call config()
  // explicitly so misconfigurations fail fast on boot.
  cloudinary.config({ secure: true });
}

// Upload a Buffer to Cloudinary under the given folder. Returns
// { url, cloudinary_id, bytes, format, resource_type } for storage in
// chat_attachments. `resource_type: 'auto'` lets Cloudinary detect images,
// videos, and "raw" docs (pdf/docx/xlsx).
function uploadBuffer(buffer, { folder, public_id, mimeType }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        public_id,
        resource_type: 'auto',
        use_filename: false,
        unique_filename: true,
        overwrite: false,
        type: 'upload'
      },
      (err, result) => {
        if (err) return reject(err);
        resolve({
          url: result.secure_url,
          cloudinary_id: result.public_id,
          bytes: result.bytes,
          format: result.format,
          resource_type: result.resource_type
        });
      }
    );
    stream.end(buffer);
  });
}

module.exports = { uploadBuffer };
