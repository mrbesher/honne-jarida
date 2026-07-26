CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'admin')),
  currency TEXT NOT NULL,
  timezone TEXT,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT NOT NULL,
  source TEXT,
  note TEXT,
  telegram_update_id INTEGER,
  telegram_item_index INTEGER,
  telegram_reply_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX expenses_user_date ON expenses(user_id, date);
CREATE UNIQUE INDEX expenses_telegram_item
ON expenses(telegram_update_id, telegram_item_index)
WHERE telegram_update_id IS NOT NULL;

CREATE TABLE incomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  source TEXT,
  note TEXT,
  telegram_update_id INTEGER,
  telegram_item_index INTEGER,
  telegram_reply_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX incomes_user_date ON incomes(user_id, date);
CREATE UNIQUE INDEX incomes_telegram_item
ON incomes(telegram_update_id, telegram_item_index)
WHERE telegram_update_id IS NOT NULL;

CREATE TABLE receipt_jobs (
  update_id INTEGER PRIMARY KEY,
  extracted_json TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pending_prompts (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
