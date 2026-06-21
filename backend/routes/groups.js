const router = require('express').Router();
const { get, all, run } = require('../db');
const auth = require('../middleware/auth');

router.use(auth);

// Get user's groups
router.get('/', (req, res) => {
  const groups = all(`
    SELECT g.*, gm.role,
           (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
    FROM groups g
    JOIN group_members gm ON g.id = gm.group_id
    WHERE gm.user_id = ?
    ORDER BY g.created_at DESC
  `, [req.user.id]);

  res.json({ groups });
});

// Create a new group
router.post('/', (req, res) => {
  const { name, description } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Group name is required' });
  }

  // Generate unique invite code
  const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();

  const result = run(`
    INSERT INTO groups (name, description, created_by, invite_code)
    VALUES (?, ?, ?, ?)
  `, [name, description || '', req.user.id, inviteCode]);

  const groupId = result.lastInsertRowid;

  // Add creator as admin (ignore if already exists)
  try {
    run(`
      INSERT OR IGNORE INTO group_members (group_id, user_id, role)
      VALUES (?, ?, 'admin')
    `, [groupId, req.user.id]);
  } catch (e) {
    // Ignore duplicate key errors
  }

  res.json({
    id: groupId,
    invite_code: inviteCode,
    message: 'Group created! 🎉 Invite your roommates with code: ' + inviteCode
  });
});

// Join group with invite code
router.post('/join', (req, res) => {
  const { invite_code } = req.body;

  if (!invite_code) {
    return res.status(400).json({ error: 'Invite code required' });
  }

  // Find group by invite code
  const group = get(`SELECT * FROM groups WHERE invite_code = ?`, [invite_code.toUpperCase()]);

  if (!group) {
    return res.status(404).json({ error: 'Invalid invite code' });
  }

  // Check if already a member
  const existing = get(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`, [group.id, req.user.id]);

  if (existing) {
    return res.status(400).json({ error: 'Already a member of this group' });
  }

  // Add member
  run(`INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')`, [group.id, req.user.id]);

  res.json({
    group: {
      id: group.id,
      name: group.name,
      description: group.description
    },
    message: 'Welcome to ' + group.name + '! 🏠'
  });
});

// Get group details and expenses
router.get('/:id', (req, res) => {
  const groupId = req.params.id;

  // Check if user is member
  const membership = get(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, req.user.id]);

  if (!membership) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }

  // Get group info
  const group = get(`
    SELECT g.*, u.name as creator_name,
           (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
    FROM groups g
    JOIN users u ON g.created_by = u.id
    WHERE g.id = ?
  `, [groupId]);

  // Get members
  const members = all(`
    SELECT u.id, u.name, u.email, gm.role, gm.joined_at
    FROM group_members gm
    JOIN users u ON gm.user_id = u.id
    WHERE gm.group_id = ?
    ORDER BY gm.joined_at
  `, [groupId]);

  // Get recent expenses
  const expenses = all(`
    SELECT ge.*, u.name as paid_by_name,
           (SELECT COUNT(*) FROM expense_splits WHERE expense_id = ge.id) as split_count,
           (SELECT SUM(amount_owed) FROM expense_splits WHERE expense_id = ge.id) as total_owed
    FROM group_expenses ge
    JOIN users u ON ge.paid_by = u.id
    WHERE ge.group_id = ?
    ORDER BY ge.created_at DESC
    LIMIT 20
  `, [groupId]);

  res.json({ group, members, expenses });
});

// Add group expense
router.post('/:id/expenses', (req, res) => {
  const groupId = req.params.id;
  const { description, amount, category, split_type } = req.body;

  if (!description || !amount) {
    return res.status(400).json({ error: 'Description and amount required' });
  }

  // Check if user is member
  const membership = get(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, req.user.id]);

  if (!membership) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }

  // Get group members
  const members = all(`SELECT user_id FROM group_members WHERE group_id = ?`, [groupId]);

  if (members.length === 0) {
    return res.status(400).json({ error: 'No members in group' });
  }

  // Create expense
  const result = run(`
    INSERT INTO group_expenses (group_id, paid_by, description, amount, category, split_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [groupId, req.user.id, description, amount, category || 'Other', split_type || 'equal']);

  const expenseId = result.lastInsertRowid;

  // Create splits
  const splitAmount = split_type === 'equal' ? amount / members.length : amount;

  for (const member of members) {
    run(`
      INSERT INTO expense_splits (expense_id, user_id, amount_owed)
      VALUES (?, ?, ?)
    `, [expenseId, member.user_id, splitAmount]);
  }

  res.json({
    id: expenseId,
    message: 'Expense added! 💰 Split between ' + members.length + ' people'
  });
});

// Mark expense split as paid
router.put('/:groupId/expenses/:expenseId/pay', (req, res) => {
  const { groupId, expenseId } = req.params;

  // Check if user is member
  const membership = get(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, req.user.id]);

  if (!membership) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }

  // Update payment
  const result = run(`
    UPDATE expense_splits
    SET amount_paid = amount_owed, status = 'paid'
    WHERE expense_id = ? AND user_id = ?
  `, [expenseId, req.user.id]);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Expense split not found' });
  }

  res.json({ message: 'Payment recorded! ✅' });
});

// Get user's balance in group
router.get('/:id/balance', (req, res) => {
  const groupId = req.params.id;

  // Check if user is member
  const membership = get(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`, [groupId, req.user.id]);

  if (!membership) {
    return res.status(403).json({ error: 'Not a member of this group' });
  }

  // Calculate balance
  const balance = get(`
    SELECT
      COALESCE(SUM(es.amount_owed), 0) as owes,
      COALESCE(SUM(es.amount_paid), 0) as paid,
      (COALESCE(SUM(es.amount_owed), 0) - COALESCE(SUM(es.amount_paid), 0)) as balance
    FROM expense_splits es
    JOIN group_expenses ge ON es.expense_id = ge.id
    WHERE ge.group_id = ? AND es.user_id = ?
  `, [groupId, req.user.id]);

  res.json({ balance: balance || { owes: 0, paid: 0, balance: 0 } });
});

module.exports = router;