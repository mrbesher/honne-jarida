ALTER TABLE users ADD COLUMN timezone TEXT;

CREATE TABLE pending_prompts (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

INSERT INTO pending_prompts (chat_id, message_id, expires_at)
SELECT chat_id, message_id, expires_at FROM pending_edits;

DROP TABLE pending_edits;
