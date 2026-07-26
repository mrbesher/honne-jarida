ALTER TABLE expenses ADD COLUMN telegram_update_id INTEGER;
ALTER TABLE expenses ADD COLUMN telegram_item_index INTEGER;
ALTER TABLE expenses ADD COLUMN telegram_reply_message_id INTEGER;

CREATE UNIQUE INDEX expenses_telegram_item
ON expenses(telegram_update_id, telegram_item_index)
WHERE telegram_update_id IS NOT NULL;

ALTER TABLE incomes ADD COLUMN telegram_update_id INTEGER;
ALTER TABLE incomes ADD COLUMN telegram_item_index INTEGER;
ALTER TABLE incomes ADD COLUMN telegram_reply_message_id INTEGER;

CREATE UNIQUE INDEX incomes_telegram_item
ON incomes(telegram_update_id, telegram_item_index)
WHERE telegram_update_id IS NOT NULL;

CREATE TABLE receipt_jobs (
  update_id INTEGER PRIMARY KEY,
  extracted_json TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
