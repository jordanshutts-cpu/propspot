const jwt = require('jsonwebtoken');

// Same JWT_SECRET as Prop Spot → same token works in both apps.
// Users live in Prop Spot's DB (which is now our DATABASE_URL), so no
// shadow-sync is needed.
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.userId    = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireAuth };
