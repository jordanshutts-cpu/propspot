const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function mintToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function hashToken(token) {
  return bcrypt.hash(token, 10);
}

async function verifyToken(token, hash) {
  return bcrypt.compare(token, hash);
}

module.exports = { mintToken, hashToken, verifyToken };
