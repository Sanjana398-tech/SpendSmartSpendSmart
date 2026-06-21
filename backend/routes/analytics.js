const router = require('express').Router();
const { get, all } = require('../db');
const auth = require('../middleware/auth');

const weekStart = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString();
};

const monthStart = () => {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

const daysInThisMonth = () => new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();

const mondayOf = d => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
};

const sumQ = (sql, p) => get(sql, p)?.v || 0;

function buildForecast(u, month_spent, month_received) {
  const now = new Date();
  const dim = daysInThisMonth();
  const day = now.getDate();
  const daysLeft = Math.max(0, dim - day);
  const dailyAvg = month_spent / Math.max(1, day);
  const projectedMonthEndBalance = u.balance - dailyAvg * daysLeft;
  let savings_rate_pct = null;
  if (month_received > 0) {
    savings_rate_pct = ((month_received - month_spent) / month_received) * 100;
  }
  return {
    projected_month_end_balance: projectedMonthEndBalance,
    savings_rate_pct,
    days_left_in_month: daysLeft,
    avg_daily_spend_month: dailyAvg,
    month_day: day,
    days_in_month: dim,
  };
}

function buildNudges(uid, u, ws, ms, month_spent, month_received) {
  const list = [];
  const seen = new Set();
  const add = (msg, t) => {
    if (!msg || seen.has(msg)) return;
    seen.add(msg);
    list.push({ msg, type: t });
  };

  const fmt = n => '₹' + Math.round(n).toLocaleString('en-IN');

  if (u.weekly_limit > 0) {
    const week_spent = sumQ(
      `SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=?`,
      [uid, ws],
    );
    const p = (week_spent / u.weekly_limit) * 100;
    if (p >= 100) add(`Weekly limit exceeded (${fmt(week_spent)} / ${fmt(u.weekly_limit)})`, 'danger');
    else if (p >= 80) add(`${Math.round(p)}% of weekly limit used — pace yourself.`, 'warn');
  }

  if (u.monthly_limit > 0) {
    const p = (month_spent / u.monthly_limit) * 100;
    if (p >= 100) add(`Monthly limit exceeded (${fmt(month_spent)} / ${fmt(u.monthly_limit)})`, 'danger');
    else if (p >= 80) add(`${Math.round(p)}% of monthly limit reached.`, 'warn');
  }

  const dim = daysInThisMonth();
  const day = new Date().getDate();
  const daysLeft = Math.max(0, dim - day);
  const dailyAvg = month_spent / Math.max(1, day);
  if (u.monthly_limit > 0 && month_spent < u.monthly_limit) {
    const projected = month_spent + dailyAvg * daysLeft;
    if (projected > u.monthly_limit) {
      add(`Trend: you may finish about ${fmt(projected - u.monthly_limit)} over your monthly budget at current pace.`, 'warn');
    }
  }

  const catRows = all(
    `SELECT category, COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=? GROUP BY category`,
    [uid, ms],
  );
  const spentByCat = Object.fromEntries(catRows.map(r => [r.category, r.total]));

  const budgets = all(`SELECT * FROM budgets WHERE user_id=? AND period='monthly'`, [uid]);
  budgets.forEach(b => {
    const lim = Number(b.limit_amount);
    if (lim <= 0) return;
    const spent = spentByCat[b.category] || 0;
    const p = (spent / lim) * 100;
    if (p >= 100) add(`${b.category} cap exceeded (${fmt(spent)} / ${fmt(lim)}).`, 'danger');
    else if (p >= 85) add(`${b.category} is at ${Math.round(p)}% of its monthly cap.`, 'warn');
  });

  const sgAmt = Number(u.savings_goal_amount) || 0;
  if (sgAmt > 0 && month_received > 0) {
    const net = month_received - month_spent;
    if (net < sgAmt) {
      add(`Savings goal: set aside ${fmt(sgAmt)} this month; net after spend is ${fmt(net)} so far.`, 'warn');
    } else {
      add(`Savings goal of ${fmt(sgAmt)} is covered by this month’s net (${fmt(net)}).`, 'ok');
    }
  }

  return list;
}

function weekdayHeatmap(uid, ms) {
  const rows = all(
    `SELECT strftime('%w', txn_date) as dow, COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=? GROUP BY dow`,
    [uid, ms],
  );
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const values = [0, 1, 2, 3, 4, 5, 6].map(i => {
    const r = rows.find(x => String(x.dow) === String(i));
    return r ? r.total : 0;
  });
  return { labels, values };
}

function categoryWeeks(uid, weekCount) {
  const anchor = mondayOf(new Date());
  const weekStarts = [];
  for (let i = weekCount - 1; i >= 0; i--) {
    const w = new Date(anchor);
    w.setDate(anchor.getDate() - i * 7);
    w.setHours(0, 0, 0, 0);
    weekStarts.push(w.getTime());
  }
  const startIso = new Date(weekStarts[0]).toISOString();
  const rows = all(
    `SELECT txn_date, category, amount FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=? ORDER BY txn_date`,
    [uid, startIso],
  );

  const catTotals = {};
  rows.forEach(r => {
    catTotals[r.category] = (catTotals[r.category] || 0) + r.amount;
  });
  const topCats = Object.entries(catTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(x => x[0]);

  if (!topCats.length) {
    return {
      labels: weekStarts.map(ws => {
        const d = new Date(ws);
        return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
      }),
      categories: [],
      series: [],
    };
  }

  const byWeek = weekStarts.map(() => {
    const o = {};
    topCats.forEach(c => {
      o[c] = 0;
    });
    return o;
  });

  rows.forEach(r => {
    const tx = new Date(r.txn_date).getTime();
    let idx = -1;
    weekStarts.forEach((ws, i) => {
      const end = ws + 7 * 86400000;
      if (tx >= ws && tx < end) idx = i;
    });
    if (idx >= 0 && topCats.includes(r.category)) byWeek[idx][r.category] += r.amount;
  });

  const labels = weekStarts.map(ws => {
    const d = new Date(ws);
    return d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
  });

  const series = topCats.map(cat => ({
    category: cat,
    values: byWeek.map(w => Math.round(w[cat])),
  }));

  return { labels, categories: topCats, series };
}

router.get('/summary', auth, (req, res) => {
  const uid = req.user.id;
  const u = req.user;
  const ws = weekStart();
  const ms = monthStart();
  const month_spent = sumQ(
    `SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=?`,
    [uid, ms],
  );
  const month_received = sumQ(
    `SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='credit' AND txn_date>=?`,
    [uid, ms],
  );

  const net_cashflow = month_received - month_spent;
  res.json({
    balance: u.balance,
    cash_balance: Number(u.cash_balance) || 0,
    online_balance: Number(u.online_balance) || 0,
    weekly_limit: u.weekly_limit,
    monthly_limit: u.monthly_limit,
    savings_goal_amount: Number(u.savings_goal_amount) || 0,
    savings_goal_note: u.savings_goal_note || '',
    week_spent: sumQ(
      `SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=?`,
      [uid, ws],
    ),
    month_spent,
    month_received,
    net_cashflow,
    total_spent: sumQ(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit'`, [uid]),
    total_received: sumQ(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='credit'`, [uid]),
    txn_count: get(`SELECT COUNT(*) as v FROM transactions WHERE user_id=?`, [uid])?.v || 0,
    forecast: buildForecast(u, month_spent, month_received),
  });
});

router.get('/weekly', auth, (req, res) => {
  const uid = req.user.id;
  const ws = weekStart();
  const rows = all(
    `SELECT strftime('%w',txn_date) as dow, type, COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND txn_date>=? GROUP BY dow,type`,
    [uid, ws],
  );
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const data = days.map((label, i) => ({
    label,
    spent: rows.find(r => r.dow == i && r.type === 'debit')?.total || 0,
    received: rows.find(r => r.dow == i && r.type === 'credit')?.total || 0,
  }));
  res.json({ data });
});

router.get('/monthly', auth, (req, res) => {
  const uid = req.user.id;
  const ms = monthStart();
  const rows = all(
    `SELECT strftime('%d',txn_date) as day, type, COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND txn_date>=? GROUP BY day,type ORDER BY day`,
    [uid, ms],
  );
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const weeks = Math.ceil(daysInMonth / 7);
  const data = Array.from({ length: weeks }, (_, w) => ({ label: 'Week ' + (w + 1), spent: 0, received: 0 }));
  rows.forEach(r => {
    const wk = Math.floor((parseInt(r.day, 10) - 1) / 7);
    if (wk < weeks) {
      if (r.type === 'debit') data[wk].spent += r.total;
      else data[wk].received += r.total;
    }
  });
  res.json({ data });
});

router.get('/categories', auth, (req, res) => {
  const uid = req.user.id;
  const { period = 'month' } = req.query;
  let since = new Date();
  if (period === 'week') {
    since.setDate(since.getDate() - since.getDay());
    since.setHours(0, 0, 0, 0);
  } else {
    since.setDate(1);
    since.setHours(0, 0, 0, 0);
  }
  const rows = all(
    `SELECT category, COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=? GROUP BY category ORDER BY total DESC`,
    [uid, since.toISOString()],
  );
  res.json({ data: rows, period });
});

router.get('/badges', auth, (req, res) => {
  const uid = req.user.id;
  const u = req.user;
  const ws = weekStart();
  const ms = monthStart();
  const cnt = (sql, p) => get(sql, p)?.c || 0;
  const sum = (sql, p) => get(sql, p)?.v || 0;
  const txnCount = cnt(`SELECT COUNT(*) as c FROM transactions WHERE user_id=?`, [uid]);
  const wkSpent = sum(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=?`, [uid, ws]);
  const moSpent = sum(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=?`, [uid, ms]);
  const catCount = cnt(`SELECT COUNT(DISTINCT category) as c FROM transactions WHERE user_id=?`, [uid]);
  const cashCount = cnt(`SELECT COUNT(*) as c FROM transactions WHERE user_id=? AND mode='cash'`, [uid]);
  const creditCount = cnt(`SELECT COUNT(*) as c FROM transactions WHERE user_id=? AND type='credit'`, [uid]);

  // Calculate streak: consecutive weeks under budget
  let streak = 0;
  if (u.weekly_limit > 0) {
    // Get weekly spending for the last 12 weeks
    const weeksData = [];
    for (let i = 0; i < 12; i++) {
      const weekStartDate = new Date();
      weekStartDate.setDate(weekStartDate.getDate() - (weekStartDate.getDay() + i * 7));
      weekStartDate.setHours(0, 0, 0, 0);
      const weekEndDate = new Date(weekStartDate);
      weekEndDate.setDate(weekStartDate.getDate() + 7);

      const weekSpent = sum(
        `SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=? AND txn_date<?`,
        [uid, weekStartDate.toISOString(), weekEndDate.toISOString()]
      );
      weeksData.push(weekSpent < u.weekly_limit);
    }

    // Count consecutive true values from the end
    for (let i = weeksData.length - 1; i >= 0; i--) {
      if (weeksData[i]) {
        streak++;
      } else {
        break;
      }
    }
  }

  const badges = [
    { id: 'first', name: 'First step', desc: 'Logged first transaction', earned: txnCount >= 1 },
    { id: 'ten', name: '10x tracker', desc: 'Logged 10 transactions', earned: txnCount >= 10 },
    { id: 'fifty', name: '50 club', desc: 'Logged 50 transactions', earned: txnCount >= 50 },
    { id: 'week_ok', name: 'Week warrior', desc: 'Under weekly budget', earned: u.weekly_limit > 0 && wkSpent < u.weekly_limit },
    { id: 'month_ok', name: 'Budget hero', desc: 'Under monthly budget', earned: u.monthly_limit > 0 && moSpent < u.monthly_limit },
    { id: 'saver', name: 'Super saver', desc: 'Under 50% of monthly budget', earned: u.monthly_limit > 0 && moSpent < u.monthly_limit * 0.5 },
    { id: 'diverse', name: 'Category pro', desc: '4+ spending categories', earned: catCount >= 4 },
    { id: 'cashier', name: 'Cash handler', desc: '10 cash transactions', earned: cashCount >= 10 },
    { id: 'earner', name: 'Money magnet', desc: '5 credit transactions', earned: creditCount >= 5 },
  ];
  res.json({ badges, streak });
});

router.get('/trends', auth, (req, res) => {
  const uid = req.user.id;
  const rows = all(
    `SELECT strftime('%Y-%m',txn_date) as month, type, COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND txn_date>=date('now','-6 months') GROUP BY month,type ORDER BY month`,
    [uid],
  );
  const months = {};
  rows.forEach(r => {
    if (!months[r.month]) months[r.month] = { label: r.month, spent: 0, received: 0 };
    if (r.type === 'debit') months[r.month].spent = r.total;
    else months[r.month].received = r.total;
  });
  res.json({ data: Object.values(months) });
});

router.get('/weekday-heatmap', auth, (req, res) => {
  const uid = req.user.id;
  res.json(weekdayHeatmap(uid, monthStart()));
});

router.get('/category-weeks', auth, (req, res) => {
  const uid = req.user.id;
  const weeks = Math.min(12, Math.max(2, parseInt(req.query.weeks, 10) || 6));
  res.json(categoryWeeks(uid, weeks));
});

router.get('/nudges', auth, (req, res) => {
  const uid = req.user.id;
  const u = req.user;
  const ws = weekStart();
  const ms = monthStart();
  const month_spent = sumQ(
    `SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=?`,
    [uid, ms],
  );
  const month_received = sumQ(
    `SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='credit' AND txn_date>=?`,
    [uid, ms],
  );
  res.json({ nudges: buildNudges(uid, u, ws, ms, month_spent, month_received) });
});

router.get('/insights-pack', auth, (req, res) => {
  const uid = req.user.id;
  const u = req.user;
  const ws = weekStart();
  const ms = monthStart();
  const month_spent = sumQ(
    `SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=?`,
    [uid, ms],
  );
  const month_received = sumQ(
    `SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='credit' AND txn_date>=?`,
    [uid, ms],
  );
  const weeks = Math.min(12, Math.max(2, parseInt(req.query.weeks, 10) || 6));
  const catRows = all(
    `SELECT category, COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=? GROUP BY category`,
    [uid, ms],
  );
  const spentByCat = Object.fromEntries(catRows.map(r => [r.category, r.total]));
  const budgets = all(`SELECT * FROM budgets WHERE user_id=? ORDER BY category`, [uid]).map(b => ({
    id: b.id,
    user_id: b.user_id,
    category: b.category,
    limit_amount: b.limit_amount,
    period: b.period,
    created_at: b.created_at,
    spent_this_month: spentByCat[b.category] || 0,
  }));

  res.json({
    heatmap: weekdayHeatmap(uid, ms),
    category_weeks: categoryWeeks(uid, weeks),
    nudges: buildNudges(uid, u, ws, ms, month_spent, month_received),
    budgets,
    forecast: buildForecast(u, month_spent, month_received),
  });
});

module.exports = router;
