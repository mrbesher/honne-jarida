import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../src/index.ts";

const database = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    currency TEXT NOT NULL,
    timezone TEXT,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    requested_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
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
  CREATE UNIQUE INDEX expenses_telegram_item
  ON expenses(telegram_update_id, telegram_item_index)
  WHERE telegram_update_id IS NOT NULL;
  CREATE TABLE incomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    source TEXT,
    note TEXT,
    telegram_update_id INTEGER,
    telegram_item_index INTEGER,
    telegram_reply_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
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
  INSERT INTO users (id, status, currency, timezone)
  VALUES (1, 'approved', 'EUR', 'Europe/Helsinki');`);

  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        params = bound;
        return statement;
      },
      first: () => sqlite.prepare(sql).get(...params) ?? null,
      run: () => {
        const result = sqlite.prepare(sql).run(...params);
        return { meta: { changes: Number(result.changes) } };
      },
      all: () => ({ results: sqlite.prepare(sql).all(...params) }),
    };
    return statement;
  };
  const db = {
    prepare,
    batch: async (statements: { run: () => unknown }[]) => statements.map(statement => statement.run()),
  } as unknown as D1Database;
  return { db, sqlite };
};

test("queued receipts finish once across duplicate delivery", async () => {
  const { db, sqlite } = database();
  const update = {
    update_id: 101,
    message: {
      message_id: 1,
      from: { id: 1 },
      chat: { id: 1 },
      photo: [{ file_id: "photo" }],
    },
  };
  let inferenceCalls = 0;
  let replies = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith("/getFile")) {
      return Response.json({ ok: true, result: { file_path: "receipts/photo.jpg" } });
    }
    if (url.includes("/file/")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/jpeg" },
      });
    }
    if (url.includes("huggingface.co")) {
      inferenceCalls++;
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ transactions: [{
          kind: "expense",
          date: "2026-07-26",
          amount: 12.5,
          currency: "EUR",
          category: "Essentials",
          subcategory: "Groceries",
          source: null,
          note: "milk, bread",
        }] }) } }],
      });
    }
    replies++;
    return Response.json({ ok: true, result: { message_id: 50, chat: { id: 1 } } });
  };
  const env = {
    DB: db,
    BACKUP: {},
    RECEIPT_QUEUE: {},
    TG_TOKEN: "telegram-token",
    TG_SECRET: "secret",
    HF_TOKEN: "hf-token",
  };
  const message = {
    body: update,
    attempts: 1,
    ack: () => undefined,
    retry: () => undefined,
  };
  const batch = { messages: [message] };

  try {
    await worker.queue!(batch as never, env as never, {} as never);
    await worker.queue!(batch as never, env as never, {} as never);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(inferenceCalls, 1);
  assert.equal(replies, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM expenses").get()!.count, 1);
  assert.ok(sqlite.prepare("SELECT completed_at FROM receipt_jobs WHERE update_id=101").get()!.completed_at);
});
