const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { run, get, all } = require('../db');
const auth = require('../middleware/auth');

const CATS = ['Food','Transport','Shopping','Bills','Entertainment','Health','Income','Other'];
const CAT_MAP = { Groceries:'Food', Rent:'Bills', Utilities:'Bills', Education:'Other', Travel:'Transport' };

function normalizeCategory(cat, type) {
  if (CATS.includes(cat)) return cat;
  if (CAT_MAP[cat]) return CAT_MAP[cat];
  return type === 'credit' ? 'Income' : 'Other';
}

function parseSmsText(text) {
  const amountPatterns = [
    /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /([\d,]+(?:\.\d{1,2})?)\s*(?:Rs\.?|INR|₹)/i,
    /(?:amount|debited?|credited?|paid|received|sent|transferred)\s+(?:of\s+)?(?:Rs\.?|₹|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ];
  let amount = null;
  for (const pattern of amountPatterns) {
    const match = text.match(pattern);
    if (match) { amount = parseFloat(match[1].replace(/,/g, '')); break; }
  }

  const sentKeywords = /sent|transferred|paid|debited/i;
  const receivedKeywords = /received|deposited|credited|refund/i;
  let type = (receivedKeywords.test(text) && !sentKeywords.test(text)) ? 'credit' : 'debit';

  const upiPatterns = [
    /(?:to|from|at|by|via|from account)\s+([A-Za-z0-9][A-Za-z0-9\s\-\.]{1,40})(?:\s+on|\s+via|\s+UPI|\.|\,|$)/i,
    /([A-Za-z0-9\s\-\.]{2,40})?#([A-Za-z0-9]+@\w+)/i,
  ];
  let description = 'Transaction';
  for (const pattern of upiPatterns) {
    const match = text.match(pattern);
    if (match) { description = match[1] ? match[1].trim() : match[0].trim(); break; }
  }

  const categoryKeywords = {
    Food: ['swiggy', 'zomato', 'dominos', 'food', 'restaurant', 'cafe', 'instamart', 'blinkit', 'grofers'],
    Transport: ['uber', 'ola', 'rapido', 'metro', 'train', 'bus', 'taxi', 'fuel', 'auto', 'cab'],
    Shopping: ['amazon', 'flipkart', 'myntra', 'shopping', 'mall', 'store', 'market'],
    Groceries: ['bigbasket', 'grofers', 'grocery', 'supermarket', 'vegetables', 'fruits'],
    Bills: ['electricity', 'water', 'jio', 'airtel', 'bsnl', 'broadband', 'recharge', 'mobile', 'phone'],
    Entertainment: ['netflix', 'hotstar', 'prime', 'movie', 'cinema', 'theatre', 'ott', 'spotify'],
    Health: ['hospital', 'pharmacy', 'medicine', 'doctor', 'clinic', 'medical', 'apollo', 'max'],
    Rent: ['rent', 'landlord', 'deposit', 'house', 'apartment'],
    Utilities: ['gas', 'cylinder', 'maintenance', 'repair'],
    Education: ['school', 'college', 'fee', 'tuition', 'book', 'course'],
    Travel: ['ixigo', 'makemytrip', 'irctc', 'flight', 'hotel', 'booking'],
    Income: ['salary', 'stipend', 'bonus', 'commission', 'freelance', 'payment'],
  };
  let category = type === 'credit' ? 'Income' : 'Other';
  let maxScore = 0;
  for (const [cat, keywords] of Object.entries(categoryKeywords)) {
    const score = keywords.reduce((count, kw) => count + (text.toLowerCase().includes(kw) ? 1 : 0), 0);
    if (score > maxScore) { maxScore = score; category = cat; }
  }

  if (text.includes('PhonePe')) {
    const m = text.match(/(?:sent|received)\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+(?:to|from)\s+([A-Za-z0-9\s\-\.]{2,40})/i);
    if (m) {
      amount = parseFloat(m[1].replace(/,/g, ''));
      description = m[2].trim();
      type = /received/i.test(text) ? 'credit' : 'debit';
    }
  } else if (text.includes('Google Pay') || text.includes('₹')) {
    const m = text.match(/(?:sent|received)\s+₹?\s*([\d,]+(?:\.\d{1,2})?)\s+(?:to|from)\s+([A-Za-z0-9\s\-\.]{2,40})/i);
    if (m) {
      amount = parseFloat(m[1].replace(/,/g, ''));
      description = m[2].trim();
      type = /received/i.test(text) ? 'credit' : 'debit';
    }
  }

  const balancePatterns = [
    /(?:avl\.?\s*bal(?:ance)?|available\s+bal(?:ance)?|a\/c\s*bal(?:ance)?|ac\s*bal(?:ance)?)[:\s]*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /bal(?:ance)?[:\s]+(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ];
  let balance_from_sms = null;
  for (const pattern of balancePatterns) {
    const m = text.match(pattern);
    if (m) { balance_from_sms = parseFloat(m[1].replace(/,/g, '')); break; }
  }

  let confidence = 0;
  if (amount) confidence += 30;
  if (description !== 'Transaction') confidence += 20;
  const typeMatches = (sentKeywords.test(text) ? 1 : 0) + (receivedKeywords.test(text) ? 1 : 0);
  confidence += typeMatches >= 2 ? 20 : (typeMatches === 1 ? 10 : 0);
  confidence += maxScore > 0 ? 20 : 5;
  if (text.length > 50) confidence += 5;
  if (balance_from_sms) confidence += 10;
  if (amount && (amount < 0.01 || amount > 1000000)) confidence = Math.max(0, confidence - 20);

  return {
    amount,
    type,
    description,
    category: normalizeCategory(category, type),
    balance_from_sms,
    confidence: confidence >= 70 ? 'high' : confidence >= 40 ? 'medium' : 'low',
  };
}

router.get('/', auth, (req, res) => {
  const { type, mode, category, from, to, limit=50, offset=0, search } = req.query;
  let sql = 'SELECT * FROM transactions WHERE user_id = ?';
  const p = [req.user.id];
  if (type)     { sql += ' AND type = ?';          p.push(type); }
  if (mode)     { sql += ' AND mode = ?';          p.push(mode); }
  if (category) { sql += ' AND category = ?';      p.push(category); }
  if (from)     { sql += ' AND txn_date >= ?';     p.push(from); }
  if (to)       { sql += ' AND txn_date <= ?';     p.push(to + ' 23:59:59'); }
  if (search)   { sql += ' AND description LIKE ?'; p.push('%' + search + '%'); }
  sql += ' ORDER BY txn_date DESC, id DESC LIMIT ? OFFSET ?';
  p.push(parseInt(limit), parseInt(offset));
  const rows = all(sql, p);
  const total = get('SELECT COUNT(*) as c FROM transactions WHERE user_id = ?', [req.user.id]).c;
  res.json({ transactions: rows, total });
});

router.get('/export', auth, (req, res) => {
  const rows = all(
    `SELECT id, txn_date, description, amount, type, category, mode FROM transactions WHERE user_id = ? ORDER BY txn_date DESC, id DESC`,
    [req.user.id],
  );
  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const cols = ['id', 'txn_date', 'description', 'amount', 'type', 'category', 'mode'];
  const lines = [cols.join(',')].concat(rows.map(t => cols.map(c => esc(t[c])).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="spendsmart-export.csv"');
  res.send(lines.join('\n'));
});

router.post('/', auth, [
  body('description').trim().notEmpty(),
  body('amount').isFloat({ gt: 0 }),
  body('type').isIn(['debit','credit']),
], (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
  const { description, amount, type, category='Other', mode='online', note, txn_date } = req.body;
  const info = run(
    `INSERT INTO transactions (user_id,description,amount,type,category,mode,note,txn_date) VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.id, description, amount, type, category, mode, note||null, txn_date||new Date().toISOString()]
  );
  const delta = type === 'credit' ? amount : -amount;
  if (mode === 'cash') {
    run(`UPDATE users SET cash_balance = cash_balance + ?, updated_at = datetime('now') WHERE id = ?`, [delta, req.user.id]);
  } else {
    run(`UPDATE users SET online_balance = online_balance + ?, updated_at = datetime('now') WHERE id = ?`, [delta, req.user.id]);
  }
  run(`UPDATE users SET balance = COALESCE(cash_balance,0) + COALESCE(online_balance,0) WHERE id = ?`, [req.user.id]);
  const txn  = get('SELECT * FROM transactions WHERE id = ?', [info.lastInsertRowid]);
  const user = get('SELECT balance FROM users WHERE id = ?', [req.user.id]);
  res.status(201).json({ transaction: txn, balance: user.balance });
});

router.get('/:id', auth, (req, res) => {
  const txn = get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!txn) return res.status(404).json({ error: 'Not found' });
  res.json({ transaction: txn });
});

router.patch('/:id', auth, (req, res) => {
  const txn = get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!txn) return res.status(404).json({ error: 'Not found' });
  const { description, category, note, txn_date } = req.body;
  run(`UPDATE transactions SET description=COALESCE(?,description),category=COALESCE(?,category),note=COALESCE(?,note),txn_date=COALESCE(?,txn_date) WHERE id=?`,
    [description||null, category||null, note||null, txn_date||null, txn.id]);
  res.json({ transaction: get('SELECT * FROM transactions WHERE id = ?', [txn.id]) });
});

router.delete('/:id', auth, (req, res) => {
  const txn = get('SELECT * FROM transactions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!txn) return res.status(404).json({ error: 'Not found' });
  run('DELETE FROM transactions WHERE id = ?', [txn.id]);
  const delta = txn.type === 'credit' ? -txn.amount : txn.amount;
  if (txn.mode === 'cash') {
    run(`UPDATE users SET cash_balance = cash_balance + ?, updated_at = datetime('now') WHERE id = ?`, [delta, req.user.id]);
  } else {
    run(`UPDATE users SET online_balance = online_balance + ?, updated_at = datetime('now') WHERE id = ?`, [delta, req.user.id]);
  }
  run(`UPDATE users SET balance = COALESCE(cash_balance,0) + COALESCE(online_balance,0) WHERE id = ?`, [req.user.id]);
  const user = get('SELECT balance FROM users WHERE id = ?', [req.user.id]);
  res.json({ message: 'Deleted', balance: user.balance });
});

router.post('/parse-sms', auth, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  res.json(parseSmsText(text));
});

router.post('/import-sms', auth, (req, res) => {
  const { text, sync_balance = true, mode = 'online' } = req.body;
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });

  const parsed = parseSmsText(String(text));
  if (!parsed.amount || parsed.amount <= 0) {
    return res.status(400).json({ error: 'Could not detect a valid amount in this message', parsed });
  }

  const note = 'SMS: ' + String(text).trim().slice(0, 240);
  const info = run(
    `INSERT INTO transactions (user_id,description,amount,type,category,mode,note,txn_date) VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.id, parsed.description, parsed.amount, parsed.type, parsed.category, mode, note, new Date().toISOString()]
  );

  const delta = parsed.type === 'credit' ? parsed.amount : -parsed.amount;
  if (mode === 'cash') {
    run(`UPDATE users SET cash_balance = cash_balance + ?, updated_at = datetime('now') WHERE id = ?`, [delta, req.user.id]);
  } else {
    run(`UPDATE users SET online_balance = online_balance + ?, updated_at = datetime('now') WHERE id = ?`, [delta, req.user.id]);
  }

  let balance_synced = false;
  if (sync_balance && parsed.balance_from_sms != null && mode === 'online') {
    run(`UPDATE users SET online_balance = ?, updated_at = datetime('now') WHERE id = ?`, [parsed.balance_from_sms, req.user.id]);
    balance_synced = true;
  }

  run(`UPDATE users SET balance = COALESCE(cash_balance,0) + COALESCE(online_balance,0) WHERE id = ?`, [req.user.id]);

  const txn = get('SELECT * FROM transactions WHERE id = ?', [info.lastInsertRowid]);
  const user = get('SELECT balance, cash_balance, online_balance FROM users WHERE id = ?', [req.user.id]);
  res.status(201).json({
    transaction: txn,
    parsed,
    balance: user.balance,
    cash_balance: user.cash_balance,
    online_balance: user.online_balance,
    balance_synced,
  });
});

module.exports = router;
