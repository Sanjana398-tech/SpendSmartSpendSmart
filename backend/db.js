const path = require('path');
const fs   = require('fs');
const initSqlJs = require('sql.js');

const DB_DIR  = process.env.DATA_DIR || __dirname;
const DB_PATH = path.join(DB_DIR, 'spendsmart.db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

let _db = null;

async function getDb() {
  if (_db) return _db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    _db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    _db = new SQL.Database();
  }
  _db.run(`PRAGMA foreign_keys = ON;`);
  _db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      name                TEXT    NOT NULL,
      email               TEXT    NOT NULL UNIQUE,
      password            TEXT    NOT NULL,
      cash_balance        REAL    NOT NULL DEFAULT 0,
      online_balance      REAL    NOT NULL DEFAULT 0,
      balance             REAL    NOT NULL DEFAULT 0,
      weekly_limit        REAL    NOT NULL DEFAULT 0,
      monthly_limit       REAL    NOT NULL DEFAULT 0,
      currency            TEXT    NOT NULL DEFAULT 'Rs',
      savings_goal_amount REAL    NOT NULL DEFAULT 0,
      savings_goal_note   TEXT    NOT NULL DEFAULT '',
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      description TEXT    NOT NULL,
      amount      REAL    NOT NULL,
      type        TEXT    NOT NULL CHECK(type IN ('debit','credit')),
      category    TEXT    NOT NULL DEFAULT 'Other',
      mode        TEXT    NOT NULL DEFAULT 'online' CHECK(mode IN ('online','cash')),
      note        TEXT,
      txn_date    TEXT    NOT NULL DEFAULT (datetime('now')),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS budgets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category      TEXT    NOT NULL,
      limit_amount  REAL    NOT NULL DEFAULT 0,
      period        TEXT    NOT NULL DEFAULT 'monthly',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, category, period)
    );
    CREATE TABLE IF NOT EXISTS challenges (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type          TEXT    NOT NULL CHECK(type IN ('no-spend-3d','no-junk-7d','custom')),
      title         TEXT    NOT NULL,
      description   TEXT,
      duration_days INTEGER NOT NULL,
      start_date    TEXT    NOT NULL,
      end_date      TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed')),
      points_earned INTEGER NOT NULL DEFAULT 0,
      streak_days   INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS groups (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      description   TEXT,
      created_by    INTEGER NOT NULL REFERENCES users(id),
      invite_code   TEXT    NOT NULL UNIQUE,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS group_members (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role          TEXT    NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
      joined_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS group_expenses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id      INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      paid_by       INTEGER NOT NULL REFERENCES users(id),
      description   TEXT    NOT NULL,
      amount        REAL    NOT NULL,
      category      TEXT    NOT NULL DEFAULT 'Other',
      split_type    TEXT    NOT NULL DEFAULT 'equal' CHECK(split_type IN ('equal','custom')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS expense_splits (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id    INTEGER NOT NULL REFERENCES group_expenses(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      amount_owed   REAL    NOT NULL,
      amount_paid   REAL    NOT NULL DEFAULT 0,
      status        TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','overdue')),
      due_date      TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_points (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      points        INTEGER NOT NULL DEFAULT 0,
      level         INTEGER NOT NULL DEFAULT 1,
      total_earned  INTEGER NOT NULL DEFAULT 0,
      last_updated  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(txn_date);
    CREATE INDEX IF NOT EXISTS idx_challenges_user ON challenges(user_id);
    CREATE INDEX IF NOT EXISTS idx_groups_member ON group_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_expenses_group ON group_expenses(group_id);
  `);

  // Create demo user if it doesn't exist
  const demoUser = get('SELECT id FROM users WHERE email = ?', ['demo@spendsmart.app']);
  if (!demoUser) {
    run(`
      INSERT INTO users (name, email, password, cash_balance, online_balance, balance, weekly_limit, monthly_limit, currency, savings_goal_amount, savings_goal_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, ['Demo User', 'demo@spendsmart.app', 'demo', 0, 50000, 50000, 5000, 15000, '₹', 0, '']);
  }

  migrateUsersColumns();
  _save();
  return _db;
}

function migrateUsersColumns() {
  const rows = all(`PRAGMA table_info(users)`);
  const names = rows.map(r => r.name);
  const addedCash = !names.includes('cash_balance');
  const addedOnline = !names.includes('online_balance');
  if (addedCash) {
    _db.run(`ALTER TABLE users ADD COLUMN cash_balance REAL NOT NULL DEFAULT 0`);
  }
  if (addedOnline) {
    _db.run(`ALTER TABLE users ADD COLUMN online_balance REAL NOT NULL DEFAULT 0`);
  }
  if (!names.includes('savings_goal_amount')) {
    _db.run(`ALTER TABLE users ADD COLUMN savings_goal_amount REAL NOT NULL DEFAULT 0`);
  }
  if (!names.includes('savings_goal_note')) {
    _db.run(`ALTER TABLE users ADD COLUMN savings_goal_note TEXT NOT NULL DEFAULT ''`);
  }
  if (addedCash || addedOnline) {
    _db.run(`UPDATE users SET online_balance = balance WHERE cash_balance = 0 AND online_balance = 0`);
  }
}

function _save() {
  if (!_db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
}

function run(sql, params = []) {
  _db.run(sql, params);
  // Get last insert rowid BEFORE saving (saving doesn't reset it, but be safe)
  const r = _db.exec('SELECT last_insert_rowid()');
  const lastInsertRowid = r[0]?.values[0][0] ?? null;
  _save();
  return { lastInsertRowid };
}

function get(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return row;
}

function all(sql, params = []) {
  const stmt = _db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

module.exports = { getDb, run, get, all };
