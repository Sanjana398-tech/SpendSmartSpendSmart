require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');
const { getDb } = require('./db');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(morgan('dev'));

app.use('/api/auth',         require('./routes/auth'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/analytics',    require('./routes/analytics'));
app.use('/api/budgets',      require('./routes/budgets'));
app.use('/api/challenges',   require('./routes/challenges'));
app.use('/api/groups',       require('./routes/groups'));
app.use('/api/points',       require('./routes/points'));
app.use('/api/ai',           require('./routes/ai'));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '../frontend/public/index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
getDb().then(() => {
  app.listen(PORT, () => console.log(`\n🚀 SpendSmart running at http://localhost:${PORT}\n`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
