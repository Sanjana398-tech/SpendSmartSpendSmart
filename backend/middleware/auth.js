const jwt = require('jsonwebtoken');
const { get } = require('../db');

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });
  const token = header.slice(7);

  // Handle demo mode
  if (token === 'demo') {
    const demoUser = get('SELECT * FROM users WHERE email = ?', ['demo@spendsmart.app']);
    if (!demoUser) return res.status(401).json({ error: 'Demo user not found' });
    req.user = demoUser;
    return next();
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = get('SELECT * FROM users WHERE id = ?', [payload.id]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
module.exports = auth;
