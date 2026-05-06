const jwt = require('jsonwebtoken');

function signToken(userId, email) {
  return jwt.sign(
    { userId, email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
}

function safeUser(u) {
  if (!u) return null;
  const { password_hash, invite_token, invite_expires, ...safe } = u;
  return safe;
}

module.exports = { signToken, safeUser };
