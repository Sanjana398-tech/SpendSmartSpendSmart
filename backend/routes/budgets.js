const router = require('express').Router();
const { run, get, all } = require('../db');
const auth = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  res.json({ budgets: all('SELECT * FROM budgets WHERE user_id = ? ORDER BY category', [req.user.id]) });
});

router.post('/', auth, (req, res) => {
  const { category, limit_amount, period='monthly' } = req.body;
  if (!category || !limit_amount) return res.status(400).json({ error: 'category and limit_amount required' });
  // upsert
  const existing = get('SELECT id FROM budgets WHERE user_id=? AND category=? AND period=?', [req.user.id, category, period]);
  if (existing) {
    run('UPDATE budgets SET limit_amount=? WHERE id=?', [limit_amount, existing.id]);
  } else {
    run('INSERT INTO budgets (user_id,category,limit_amount,period) VALUES (?,?,?,?)', [req.user.id,category,limit_amount,period]);
  }
  res.json({ message: 'Budget saved' });
});

router.delete('/:id', auth, (req, res) => {
  run('DELETE FROM budgets WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  res.json({ message: 'Deleted' });
});

module.exports = router;
