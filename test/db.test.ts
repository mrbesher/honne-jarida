import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  duplicateExpense,
  duplicateIncome,
  insertReceiptExpense,
  receiptExpense,
  type Expense,
  type Income,
} from "../src/db.ts";

type Input = Omit<Expense, "id" | "user_id" | "created_at">;

const expense: Input = {
  date: "2026-07-18",
  amount_cents: 1299,
  category: "Eating Out",
  subcategory: "Cafe",
  source: null,
  note: "Coffee",
};

const database = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    category TEXT NOT NULL,
    subcategory TEXT NOT NULL,
    source TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: () => sqlite.prepare(sql).get(...params) ?? null,
      }),
    }),
  } as unknown as D1Database;
  const insert = (userId: number, value: Input) => Number(sqlite.prepare(
    "INSERT INTO expenses (user_id, date, amount_cents, category, subcategory, source, note) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(userId, value.date, value.amount_cents, value.category, value.subcategory, value.source, value.note)!.id);
  return { db, insert };
};

test("finds an exact same-user, same-date duplicate", async () => {
  const { db, insert } = database();
  const original = insert(1, expense);
  const added = insert(1, expense);
  assert.equal((await duplicateExpense(db, 1, added, expense))?.id, original);
});

test("does not match another user or date", async () => {
  const { db, insert } = database();
  insert(2, expense);
  insert(1, { ...expense, date: "2026-07-17" });
  const added = insert(1, expense);
  assert.equal(await duplicateExpense(db, 1, added, expense), null);
});

test("requires every persisted expense field to match", async () => {
  const changes: Input[] = [
    { ...expense, amount_cents: 1300 },
    { ...expense, category: "Essentials", subcategory: "Groceries" },
    { ...expense, subcategory: "Restaurant" },
    { ...expense, source: "Cash" },
    { ...expense, note: "Tea" },
  ];
  for (const changed of changes) {
    const { db, insert } = database();
    insert(1, changed);
    const added = insert(1, expense);
    assert.equal(await duplicateExpense(db, 1, added, expense), null);
  }
});

test("finds only exact same-user income duplicates", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE incomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    source TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: () => sqlite.prepare(sql).get(...params) ?? null,
      }),
    }),
  } as unknown as D1Database;
  const income: Omit<Income, "id" | "user_id" | "created_at"> = {
    date: "2026-07-18",
    amount_cents: 250000,
    source: "JYU Salary",
    note: null,
  };
  const insert = (userId: number, value: typeof income) => Number(sqlite.prepare(
    "INSERT INTO incomes (user_id, date, amount_cents, source, note) VALUES (?, ?, ?, ?, ?) RETURNING id"
  ).get(userId, value.date, value.amount_cents, value.source, value.note)!.id);

  insert(2, income);
  const original = insert(1, income);
  const added = insert(1, income);
  assert.equal((await duplicateIncome(db, 1, added, income))?.id, original);
  assert.equal(await duplicateIncome(db, 1, added, { ...income, source: "S Market Bonus" }), null);
});

test("receipt expenses are idempotent by update and item", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE expenses (
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
  WHERE telegram_update_id IS NOT NULL;`);
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: () => sqlite.prepare(sql).get(...params) ?? null,
      }),
    }),
  } as unknown as D1Database;

  const inserted = await insertReceiptExpense(db, 1, 99, 0, expense);
  const duplicate = await insertReceiptExpense(db, 1, 99, 0, expense);
  const stored = await receiptExpense(db, 99, 0);

  assert.equal(inserted?.id, 1);
  assert.equal(duplicate, null);
  assert.equal(stored?.id, 1);
  assert.equal(stored?.telegram_reply_message_id, null);
});
