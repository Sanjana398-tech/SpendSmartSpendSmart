const router = require('express').Router();
const { get, all, run } = require('../db');
const auth = require('../middleware/auth');

router.use(auth);

// Get user's points and level
router.get('/', (req, res) => {
  let points = get(`SELECT * FROM user_points WHERE user_id = ?`, [req.user.id]);

  if (!points) {
    // Initialize points for new users
    points = {
      points: 0,
      level: 1,
      total_earned: 0,
      last_updated: new Date().toISOString()
    };
  }

  // Get recent achievements
  const recentChallenges = all(`
    SELECT title, points_earned, status, end_date
    FROM challenges
    WHERE user_id = ? AND status = 'completed' AND points_earned > 0
    ORDER BY end_date DESC
    LIMIT 5
  `, [req.user.id]);

  res.json({
    points,
    recent_achievements: recentChallenges,
    level_progress: {
      current_level: points.level,
      points_to_next: (points.level * 100) - (points.total_earned % 100),
      progress_percent: ((points.total_earned % 100) / 100) * 100
    }
  });
});

// Get leaderboard (top users by points)
router.get('/leaderboard', (req, res) => {
  const leaderboard = all(`
    SELECT u.name, up.points, up.level, up.total_earned
    FROM user_points up
    JOIN users u ON up.user_id = u.id
    ORDER BY up.total_earned DESC
    LIMIT 10
  `);

  res.json({ leaderboard });
});

// Award bonus points (admin function - could be triggered by special events)
router.post('/bonus', (req, res) => {
  const { points, reason } = req.body;

  if (!points || points <= 0) {
    return res.status(400).json({ error: 'Valid points amount required' });
  }

  // Update user points
  let userPoints = get(`SELECT * FROM user_points WHERE user_id = ?`, [req.user.id]);

  if (!userPoints) {
    run(`INSERT INTO user_points (user_id, points, total_earned) VALUES (?, ?, ?)`, [req.user.id, points, points]);
  } else {
    const newTotal = userPoints.total_earned + points;
    const newLevel = Math.floor(newTotal / 100) + 1;

    run(`
      UPDATE user_points
      SET points = points + ?, total_earned = ?, level = ?, last_updated = datetime('now')
      WHERE user_id = ?
    `, [points, newTotal, newLevel, req.user.id]);
  }

  res.json({
    message: `Bonus points awarded! 🎉 +${points} points for: ${reason || 'being awesome'}`
  });
});

// Get points history/achievements
router.get('/history', (req, res) => {
  const achievements = all(`
    SELECT
      'challenge' as type,
      title as description,
      points_earned as points,
      end_date as date
    FROM challenges
    WHERE user_id = ? AND status = 'completed' AND points_earned > 0
    UNION ALL
    SELECT
      'bonus' as type,
      'Bonus Points' as description,
      points as points,
      last_updated as date
    FROM user_points
    WHERE user_id = ? AND points > 0
    ORDER BY date DESC
    LIMIT 20
  `, [req.user.id, req.user.id]);

  res.json({ achievements });
});

module.exports = router;