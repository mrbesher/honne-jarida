CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT,
  subcategory TEXT,
  source TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX transactions_date ON transactions(date);

CREATE TABLE pending_edits (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  txn_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
