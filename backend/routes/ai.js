const router = require('express').Router();
const Groq   = require('groq-sdk');
const { get, all, run } = require('../db');
const auth = require('../middleware/auth');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

router.use(auth);

// ─── TOOL DEFINITIONS ────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'add_transaction',
      description: 'Add a debit (expense) or credit (income) transaction. Call this whenever the user mentions spending money, paying for something, receiving money, or getting paid.',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Merchant or description, e.g. "Swiggy", "Salary"' },
          amount:      { type: 'number', description: 'Amount in INR, positive number' },
          type:        { type: 'string', enum: ['debit','credit'], description: 'debit=expense, credit=income/received' },
          category:    { type: 'string', enum: ['Food','Transport','Shopping','Bills','Entertainment','Health','Income','Other'] },
          mode:        { type: 'string', enum: ['online','cash'], description: 'Payment mode, default online' },
          note:        { type: 'string', description: 'Optional note' }
        },
        required: ['description','amount','type','category','mode']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_balance',
      description: 'Get current balance, cash/online split, and this month\'s spending and income totals.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_transactions',
      description: 'Fetch recent transactions with optional filters.',
      parameters: {
        type: 'object',
        properties: {
          limit:    { type: 'number',  description: 'How many to return (default 10, max 50)' },
          type:     { type: 'string',  enum: ['debit','credit'] },
          category: { type: 'string',  description: 'Filter by category' },
          search:   { type: 'string',  description: 'Search term in description' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_analytics',
      description: 'Get spending breakdown by category and totals for this week or month.',
      parameters: {
        type: 'object',
        properties: {
          period: { type: 'string', enum: ['week','month'], description: 'default month' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_insights',
      description: 'Get financial insights: projections, savings rate, nudges, top categories, budget status.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_budget',
      description: 'Set or update a monthly spending cap for a category.',
      parameters: {
        type: 'object',
        properties: {
          category:     { type: 'string', enum: ['Food','Transport','Shopping','Bills','Entertainment','Health','Other'] },
          limit_amount: { type: 'number', description: 'Monthly cap in INR' }
        },
        required: ['category','limit_amount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_transaction',
      description: 'Delete a specific transaction by ID.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Transaction ID' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_settings',
      description: 'Update user settings: weekly_limit, monthly_limit, cash_balance, online_balance, savings_goal_amount, savings_goal_note.',
      parameters: {
        type: 'object',
        properties: {
          weekly_limit:         { type: 'number' },
          monthly_limit:        { type: 'number' },
          cash_balance:         { type: 'number' },
          online_balance:       { type: 'number' },
          savings_goal_amount:  { type: 'number' },
          savings_goal_note:    { type: 'string' }
        }
      }
    }
  }
];

// ─── TOOL EXECUTOR ───────────────────────────────────────────────
async function executeTool(name, args, uid) {
  switch (name) {

    case 'add_transaction': {
      const { description, amount, type, category = 'Other', mode = 'online', note } = args;
      if (!description || !amount || amount <= 0) return { error: 'Invalid transaction data' };
      const info = run(
        `INSERT INTO transactions (user_id,description,amount,type,category,mode,note,txn_date) VALUES (?,?,?,?,?,?,?,?)`,
        [uid, description, amount, type, category, mode, note || null, new Date().toISOString()]
      );
      const delta = type === 'credit' ? amount : -amount;
      if (mode === 'cash') {
        run(`UPDATE users SET cash_balance = cash_balance + ?, updated_at = datetime('now') WHERE id = ?`, [delta, uid]);
      } else {
        run(`UPDATE users SET online_balance = online_balance + ?, updated_at = datetime('now') WHERE id = ?`, [delta, uid]);
      }
      run(`UPDATE users SET balance = COALESCE(cash_balance,0) + COALESCE(online_balance,0) WHERE id = ?`, [uid]);
      const u = get('SELECT balance, cash_balance, online_balance FROM users WHERE id = ?', [uid]);
      return {
        success: true,
        transaction_id: info.lastInsertRowid,
        action: `${type === 'credit' ? 'Credited' : 'Debited'} ₹${amount} for "${description}"`,
        new_balance: u.balance,
        new_cash_balance: u.cash_balance,
        new_online_balance: u.online_balance
      };
    }

    case 'get_balance': {
      const u = get('SELECT balance,cash_balance,online_balance,weekly_limit,monthly_limit,savings_goal_amount FROM users WHERE id=?', [uid]);
      const now = new Date();
      const ms  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const ws  = new Date(now - now.getDay() * 86400000); ws.setHours(0,0,0,0);
      const monthSpent  = get(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit'  AND txn_date>=?`, [uid, ms])?.v || 0;
      const monthIncome = get(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='credit' AND txn_date>=?`, [uid, ms])?.v || 0;
      const weekSpent   = get(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit'  AND txn_date>=?`, [uid, ws.toISOString()])?.v || 0;
      return {
        total_balance: u.balance,
        cash_balance: u.cash_balance,
        online_balance: u.online_balance,
        this_month_spent: monthSpent,
        this_month_income: monthIncome,
        this_week_spent: weekSpent,
        weekly_limit: u.weekly_limit,
        monthly_limit: u.monthly_limit,
        savings_goal: u.savings_goal_amount,
        net_this_month: monthIncome - monthSpent
      };
    }

    case 'get_transactions': {
      const { limit = 10, type, category, search } = args;
      let sql = 'SELECT * FROM transactions WHERE user_id = ?';
      const p = [uid];
      if (type)     { sql += ' AND type = ?';            p.push(type); }
      if (category) { sql += ' AND category = ?';        p.push(category); }
      if (search)   { sql += ' AND description LIKE ?';  p.push('%' + search + '%'); }
      sql += ' ORDER BY txn_date DESC LIMIT ?';
      p.push(Math.min(Number(limit) || 10, 50));
      const txns = all(sql, p);
      return { transactions: txns.map(t => ({ id: t.id, date: t.txn_date, description: t.description, amount: t.amount, type: t.type, category: t.category, mode: t.mode })), count: txns.length };
    }

    case 'get_analytics': {
      const period = (args && args.period) || 'month';
      const now    = new Date();
      const since  = period === 'week'
        ? (() => { const d = new Date(now - now.getDay()*86400000); d.setHours(0,0,0,0); return d; })()
        : new Date(now.getFullYear(), now.getMonth(), 1);
      const cats   = all(`SELECT category, COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=? GROUP BY category ORDER BY total DESC`, [uid, since.toISOString()]);
      const totals = get(`SELECT COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END),0) as spent, COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE 0 END),0) as income FROM transactions WHERE user_id=? AND txn_date>=?`, [uid, since.toISOString()]) || { spent: 0, income: 0 };
      const spent  = totals.spent  || 0;
      const income = totals.income || 0;
      return { period, total_spent: spent, total_income: income, net: income - spent, savings_rate: income > 0 ? ((income-spent)/income*100).toFixed(1)+'%' : 'N/A', by_category: cats };
    }

    case 'get_insights': {
      const u   = get('SELECT * FROM users WHERE id=?', [uid]);
      const now = new Date();
      const ms  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const monthSpent  = get(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit'  AND txn_date>=?`, [uid, ms])?.v || 0;
      const monthIncome = get(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='credit' AND txn_date>=?`, [uid, ms])?.v || 0;
      const topCats = all(`SELECT category, COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=? GROUP BY category ORDER BY total DESC LIMIT 3`, [uid, ms]);
      const dim  = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
      const daily = monthSpent / Math.max(1, now.getDate());
      const proj  = monthSpent + daily * (dim - now.getDate());
      const budgets = all('SELECT * FROM budgets WHERE user_id=? AND period=?', [uid, 'monthly']);
      const nudges  = [];
      if (u.weekly_limit > 0) {
        const ws = new Date(now - now.getDay()*86400000); ws.setHours(0,0,0,0);
        const wkS = get(`SELECT COALESCE(SUM(amount),0) as v FROM transactions WHERE user_id=? AND type='debit' AND txn_date>=?`, [uid, ws.toISOString()])?.v || 0;
        if (wkS > u.weekly_limit)   nudges.push(`Weekly limit exceeded: ₹${Math.round(wkS)} of ₹${u.weekly_limit}`);
        else if (wkS > u.weekly_limit*0.8) nudges.push(`At ${Math.round(wkS/u.weekly_limit*100)}% of weekly limit`);
      }
      if (u.monthly_limit > 0 && proj > u.monthly_limit) nudges.push(`On track to exceed monthly limit by ₹${Math.round(proj-u.monthly_limit)}`);
      return {
        balance: u.balance, this_month_spent: monthSpent, this_month_income: monthIncome,
        projected_month_end: Math.round(proj), daily_avg_spend: Math.round(daily),
        days_left_in_month: dim - now.getDate(),
        savings_rate: monthIncome > 0 ? ((monthIncome-monthSpent)/monthIncome*100).toFixed(1)+'%' : 'N/A',
        top_spending_categories: topCats, nudges,
        budget_caps: budgets.map(b => ({ category: b.category, limit: b.limit_amount, spent: topCats.find(c=>c.category===b.category)?.total || 0 }))
      };
    }

    case 'set_budget': {
      const { category, limit_amount } = args;
      const ex = get('SELECT id FROM budgets WHERE user_id=? AND category=? AND period=?', [uid, category, 'monthly']);
      if (ex) run('UPDATE budgets SET limit_amount=? WHERE id=?', [limit_amount, ex.id]);
      else    run('INSERT INTO budgets (user_id,category,limit_amount,period) VALUES (?,?,?,?)', [uid, category, limit_amount, 'monthly']);
      return { success: true, message: `Monthly budget for ${category} set to ₹${limit_amount}` };
    }

    case 'delete_transaction': {
      const txn = get('SELECT * FROM transactions WHERE id=? AND user_id=?', [args.id, uid]);
      if (!txn) return { error: 'Transaction not found' };
      run('DELETE FROM transactions WHERE id=?', [txn.id]);
      const delta = txn.type === 'credit' ? -txn.amount : txn.amount;
      if (txn.mode === 'cash') run(`UPDATE users SET cash_balance=cash_balance+?,updated_at=datetime('now') WHERE id=?`, [delta, uid]);
      else                     run(`UPDATE users SET online_balance=online_balance+?,updated_at=datetime('now') WHERE id=?`, [delta, uid]);
      run(`UPDATE users SET balance=COALESCE(cash_balance,0)+COALESCE(online_balance,0) WHERE id=?`, [uid]);
      return { success: true, message: `Deleted: "${txn.description}" ₹${txn.amount}` };
    }

    case 'update_settings': {
      const allowed = ['weekly_limit','monthly_limit','cash_balance','online_balance','savings_goal_amount','savings_goal_note'];
      const updates = {};
      allowed.forEach(f => { if (args[f] !== undefined) updates[f] = args[f]; });
      if (!Object.keys(updates).length) return { error: 'No valid fields to update' };
      const set = Object.keys(updates).map(k => `${k}=?`).join(', ');
      run(`UPDATE users SET ${set}, balance=COALESCE(cash_balance,0)+COALESCE(online_balance,0), updated_at=datetime('now') WHERE id=?`, [...Object.values(updates), uid]);
      return { success: true, message: 'Settings updated', updated: updates };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── SYSTEM PROMPT ───────────────────────────────────────────────
function buildSystem(user) {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  return `You are SpendSmart AI — a friendly, smart personal finance assistant embedded in the SpendSmart expense tracker.

Current date/time (IST): ${now}
User: ${user.name}
Balance: ₹${user.balance} total (Cash: ₹${user.cash_balance||0}, Online: ₹${user.online_balance||0})
Weekly limit: ${user.weekly_limit > 0 ? '₹'+user.weekly_limit : 'not set'}
Monthly limit: ${user.monthly_limit > 0 ? '₹'+user.monthly_limit : 'not set'}

## RULES
1. ALWAYS call tools to fetch or modify real data — never make up numbers.
2. For any spending/income mention ("spent X on Y", "paid X", "received X", "salary X"), IMMEDIATELY call add_transaction — no confirmation needed unless amount or merchant is missing.
3. Infer mode: "cash" if user says cash/paid cash/ATM, otherwise "online".
4. Infer category from context: restaurant/food app → Food, cab/metro → Transport, salary/freelance → Income, electricity/internet → Bills, etc.
5. Respond concisely and friendly. Use ₹ for all amounts. Use line breaks for lists.
6. After adding a transaction, state what was recorded and show the new balance.
7. For questions about spending, call get_analytics or get_balance first.
8. When asked for tips or advice, call get_insights first for context.
9. Support Hindi-English mix naturally.

## EXAMPLES
- "spent 200 on zomato" → add_transaction(desc="Zomato", amount=200, type="debit", category="Food", mode="online")
- "received 45000 salary" → add_transaction(desc="Salary", amount=45000, type="credit", category="Income", mode="online")
- "paid 50 cash for tea" → add_transaction(desc="Tea", amount=50, type="debit", category="Food", mode="cash")
- "kitna kharch hua is mahine?" → get_analytics(period="month") then answer in Hinglish
- "set food limit 3000" → set_budget(category="Food", limit_amount=3000)
- "am I overspending?" → get_insights() then give honest advice`;
}

// ─── MAIN CHAT ENDPOINT ──────────────────────────────────────────
router.post('/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });

  const uid  = req.user.id;
  const user = get('SELECT * FROM users WHERE id=?', [uid]);
  if (!user) return res.status(401).json({ error: 'User not found' });

  try {
    const history = [
      { role: 'system', content: buildSystem(user) },
      ...messages.slice(-20)          // last 20 messages for context window
    ];

    const toolResults = [];
    const MAX_ROUNDS  = 6;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const completion = await groq.chat.completions.create({
        model:       'llama-3.3-70b-versatile',
        messages:    history,
        tools:       TOOLS,
        tool_choice: 'auto',
        max_tokens:  1024,
        temperature: 0.5
      });

      const msg = completion.choices[0].message;
      history.push(msg);

      // No tool calls → final response
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return res.json({ reply: msg.content || '✅ Done!', tool_results: toolResults });
      }

      // Execute each tool call in sequence
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments); } catch {}

        const result = await executeTool(tc.function.name, args, uid);
        toolResults.push({ tool: tc.function.name, args, result });

        history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result)
        });
      }
    }

    // Exhausted rounds — return last assistant text
    const last = [...history].reverse().find(m => m.role === 'assistant' && m.content);
    return res.json({ reply: last?.content || 'Done! ✅', tool_results: toolResults });

  } catch (err) {
    console.error('AI error:', err?.message || err);
    const status = err?.status || err?.statusCode;
    if (status === 401) return res.status(500).json({ error: 'Invalid Groq API key — check your .env file' });
    if (status === 429) return res.status(500).json({ error: 'Rate limit reached — please wait a moment and try again' });
    return res.status(500).json({ error: err?.message || 'AI request failed' });
  }
});

module.exports = router;
