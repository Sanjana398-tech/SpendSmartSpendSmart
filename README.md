# SpendSmart — Full-Stack Expense Tracker

A beautiful, animated personal finance tracker with a Node.js/Express backend
and a stunning dark-mode frontend.

---

## Tech Stack

| Layer    | Tech                                          |
|----------|-----------------------------------------------|
| Backend  | Node.js · Express · SQLite (better-sqlite3)   |
| Auth     | JWT (jsonwebtoken) · bcryptjs                 |
| Frontend | Vanilla HTML/CSS/JS · Chart.js                |
| DB       | SQLite — zero config, single file             |

---

## Project Structure

```
spendsmart/
├── backend/
│   ├── server.js              # Express app entry point
│   ├── db.js                  # SQLite setup & schema
│   ├── .env                   # Environment variables
│   ├── package.json
│   ├── middleware/
│   │   └── auth.js            # JWT auth middleware
│   └── routes/
│       ├── auth.js            # Register / login / me / update
│       ├── transactions.js    # CRUD + SMS parser
│       ├── analytics.js       # Summary / charts / badges
│       └── budgets.js         # Category budgets
└── frontend/
    └── public/
        └── index.html         # Single-page app
```

---

## Quick Start

### 1. Install dependencies

```bash
cd spendsmart/backend
npm install
```

### 2. Start the server

```bash
npm start
# or for development with auto-reload:
npm run dev
```

The server starts at **http://localhost:3001**

The frontend is served automatically at **http://localhost:3001**

---

## API Reference

### Auth
| Method | Endpoint         | Description         |
|--------|-----------------|---------------------|
| POST   | /api/auth/register | Create account   |
| POST   | /api/auth/login    | Sign in          |
| GET    | /api/auth/me       | Get profile      |
| PATCH  | /api/auth/me       | Update settings  |

### Transactions
| Method | Endpoint                        | Description          |
|--------|---------------------------------|----------------------|
| GET    | /api/transactions               | List (with filters)  |
| POST   | /api/transactions               | Create               |
| GET    | /api/transactions/:id           | Get one              |
| PATCH  | /api/transactions/:id           | Update               |
| DELETE | /api/transactions/:id           | Delete               |
| POST   | /api/transactions/parse-sms     | Parse bank SMS       |

**Query filters for GET /api/transactions:**
- `type` — `debit` or `credit`
- `mode` — `cash` or `online`
- `category` — Food, Transport, etc.
- `from` / `to` — date range (ISO strings)
- `search` — text search in description
- `limit` / `offset` — pagination

### Analytics
| Method | Endpoint                   | Description             |
|--------|---------------------------|-------------------------|
| GET    | /api/analytics/summary    | Balance + totals        |
| GET    | /api/analytics/weekly     | Day-by-day this week    |
| GET    | /api/analytics/monthly    | Week-by-week this month |
| GET    | /api/analytics/categories | Spending by category    |
| GET    | /api/analytics/badges     | Earned badges           |
| GET    | /api/analytics/trends     | 6-month trend           |

### Budgets
| Method | Endpoint          | Description        |
|--------|------------------|--------------------|
| GET    | /api/budgets     | List budgets       |
| POST   | /api/budgets     | Create/update      |
| DELETE | /api/budgets/:id | Delete             |

---

## SMS Parser

POST `/api/transactions/parse-sms` with `{ "text": "<sms message>" }`

Returns:
```json
{
  "amount": 1500,
  "type": "debit",
  "description": "Swiggy",
  "category": "Food",
  "confidence": "high"
}
```

Supports formats from SBI, HDFC, ICICI, Axis, Kotak, UPI alerts, etc.

---

## Environment Variables (.env)

```
PORT=3001
JWT_SECRET=change_this_in_production
NODE_ENV=development
```

---

## Demo Account

Use email `demo@spendsmart.app` with any password in offline mode —
the frontend will load with sample data without needing the backend.

---

## Features

- JWT authentication with 30-day tokens
- Persistent SQLite database (auto-created on first run)
- SMS/UPI message parsing with category auto-detection
- Weekly & monthly budget limits with live progress bars
- Animated warning banners at 80% and 100% of limits
- Charts: weekly, monthly, category breakdown
- 9 achievement badges
- Full CRUD on transactions (including delete with balance reversal)
- Category-level budgets
- Spending trends over last 6 months
- Dark mode UI with ambient animations
