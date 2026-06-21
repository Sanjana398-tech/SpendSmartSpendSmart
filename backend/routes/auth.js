const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { run, get } = require('../db');
const auth    = require('../middleware/auth');

const sign = (user) => jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
const safe = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  balance: Number(u.balance) || 0,
  cash_balance: Number(u.cash_balance) || 0,
  online_balance: Number(u.online_balance) || 0,
  weekly_limit: u.weekly_limit,
  monthly_limit: u.monthly_limit,
  currency: u.currency,
  savings_goal_amount: u.savings_goal_amount != null ? u.savings_goal_amount : 0,
  savings_goal_note: u.savings_goal_note != null ? u.savings_goal_note : '',
  created_at: u.created_at,
});

router.post('/register', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
], (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });

  const {
    name, email, password,
    balance    = 0,
    weekly_limit  = 0,
    monthly_limit = 0,
    cash_balance,
    online_balance,
  } = req.body;

  const existing = get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash   = bcrypt.hashSync(password, 10);
  const cash   = Math.max(0, parseFloat(cash_balance)   || 0);
  const online = Math.max(0, parseFloat(online_balance)  || 0);
  // If neither cash nor online provided, fall back to balance field
  const total  = (cash + online) > 0 ? cash + online : Math.max(0, parseFloat(balance) || 0);
  const finalOnline = (cash + online) > 0 ? online : total;

  try {
    const info = run(
      'INSERT INTO users (name,email,password,cash_balance,online_balance,balance,weekly_limit,monthly_limit) VALUES (?,?,?,?,?,?,?,?)',
      [name, email, hash, cash, finalOnline, total, parseFloat(weekly_limit)||0, parseFloat(monthly_limit)||0]
    );

    if (!info.lastInsertRowid) {
      return res.status(500).json({ error: 'Failed to create account — try a different email' });
    }

    const user = get('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid]);
    if (!user) return res.status(500).json({ error: 'Account created but could not retrieve user' });

    res.status(201).json({ token: sign(user), user: safe(user) });
  } catch (e) {
    console.error('Register error:', e.message);
    if (e.message && e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: 'Registration failed: ' + e.message });
  }
});

router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
  const { email, password } = req.body;
  const user = get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid email or password' });
  res.json({ token: sign(user), user: safe(user) });
});

router.get('/me', auth, (req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json({ user: safe(user) });
});

router.patch('/me', auth, (req, res) => {
  const { name, cash_balance, online_balance, weekly_limit, monthly_limit, currency, savings_goal_amount, savings_goal_note } = req.body;
  const fields = { name, cash_balance, online_balance, weekly_limit, monthly_limit, currency, savings_goal_amount, savings_goal_note };
  const updates = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
  if (updates.cash_balance !== undefined) {
    updates.cash_balance = Math.max(0, parseFloat(updates.cash_balance) || 0);
  }
  if (updates.online_balance !== undefined) {
    updates.online_balance = Math.max(0, parseFloat(updates.online_balance) || 0);
  }
  if (updates.savings_goal_amount !== undefined) {
    updates.savings_goal_amount = Math.max(0, parseFloat(updates.savings_goal_amount) || 0);
  }
  if (updates.savings_goal_note !== undefined) {
    updates.savings_goal_note = String(updates.savings_goal_note || '').slice(0, 500);
  }
  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  run(`UPDATE users SET ${setClauses}, balance = COALESCE(cash_balance,0) + COALESCE(online_balance,0), updated_at = datetime('now') WHERE id = ?`,
    [...Object.values(updates), req.user.id]);
  const updated = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json({ user: safe(updated) });
});

module.exports = router;
