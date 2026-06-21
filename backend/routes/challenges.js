const router = require('express').Router();
const { get, all, run } = require('../db');
const auth = require('../middleware/auth');

router.use(auth);

// Get challenge stats — MUST be before /:id to avoid route conflict
router.get('/stats', (req, res) => {
  const stats = get(`
    SELECT
      COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
      COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
      COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
      SUM(points_earned) as total_points,
      MAX(streak_days) as best_streak
    FROM challenges
    WHERE user_id = ?
  `, [req.user.id]);

  res.json({ stats: stats || { completed: 0, active: 0, failed: 0, total_points: 0, best_streak: 0 } });
});

// Get user's challenges
router.get('/', (req, res) => {
  const challenges = all(`
    SELECT * FROM challenges
    WHERE user_id = ?
    ORDER BY created_at DESC
  `, [req.user.id]);

  res.json({ challenges });
});

// Create a new challenge
router.post('/', (req, res) => {
  const { type, title, description, duration_days } = req.body;

  if (!type || !title || !duration_days) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const start_date = new Date().toISOString();
  const end_date = new Date(Date.now() + duration_days * 24 * 60 * 60 * 1000).toISOString();

  const result = run(`
    INSERT INTO challenges (user_id, type, title, description, duration_days, start_date, end_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [req.user.id, type, title, description || '', duration_days, start_date, end_date]);

  res.json({
    id: result.lastInsertRowid,
    message: 'Challenge created! 💪'
  });
});

// Update challenge status
router.put('/:id', (req, res) => {
  const { status, points_earned, streak_days } = req.body;
  const challengeId = req.params.id;

  // Verify ownership
  const challenge = get(`SELECT * FROM challenges WHERE id = ? AND user_id = ?`, [challengeId, req.user.id]);
  if (!challenge) {
    return res.status(404).json({ error: 'Challenge not found' });
  }

  run(`
    UPDATE challenges
    SET status = ?, points_earned = ?, streak_days = ?, updated_at = datetime('now')
    WHERE id = ?
  `, [status || challenge.status, points_earned || challenge.points_earned, streak_days || challenge.streak_days, challengeId]);

  // Update user points if completed
  if (status === 'completed' && points_earned > 0) {
    updateUserPoints(req.user.id, points_earned);
  }

  res.json({ message: 'Challenge updated! 🎉' });
});

// Delete challenge
router.delete('/:id', (req, res) => {
  const challengeId = req.params.id;

  const result = run(`DELETE FROM challenges WHERE id = ? AND user_id = ?`, [challengeId, req.user.id]);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Challenge not found' });
  }

  res.json({ message: 'Challenge deleted 💀' });
});



function updateUserPoints(userId, points) {
  // Get or create points record
  let userPoints = get(`SELECT * FROM user_points WHERE user_id = ?`, [userId]);

  if (!userPoints) {
    run(`INSERT INTO user_points (user_id, points, total_earned) VALUES (?, ?, ?)`, [userId, points, points]);
  } else {
    const newTotal = userPoints.total_earned + points;
    const newLevel = Math.floor(newTotal / 100) + 1; // Level up every 100 points

    run(`
      UPDATE user_points
      SET points = points + ?, total_earned = ?, level = ?, last_updated = datetime('now')
      WHERE user_id = ?
    `, [points, newTotal, newLevel, userId]);
  }
}

module.exports = router;