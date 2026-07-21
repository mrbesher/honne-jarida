import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runCashflowQuery, runExpenseQuery, runIncomeQuery } from "../src/query.ts";

const database = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, category TEXT NOT NULL, subcategory TEXT NOT NULL,
      source TEXT, note TEXT
    );
    CREATE TABLE incomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL, source TEXT, note TEXT
    );
  `);
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({ all: () => ({ results: sqlite.prepare(sql).all(...params) }) }),
    }),
  } as unknown as D1Database;
  return { sqlite, db };
};

test("income search is user-scoped, case-insensitive, and literal", async () => {
  const { sqlite, db } = database();
  const insert = sqlite.prepare("INSERT INTO incomes (user_id, date, amount_cents, source, note) VALUES (?, ?, ?, ?, ?)");
  insert.run(1, "2026-07-01", 10_000, "Bonus_100%", "Summer");
  insert.run(1, "2026-07-02", 20_000, "BonusX100Y", "Summer");
  insert.run(2, "2026-07-03", 99_000, "Bonus_100%", "Other user");

  const result = await runIncomeQuery(db, 1, { where: { source_like: "_100%" } });
  assert.deepEqual(result.rows.map(row => (row as { amount_cents: number }).amount_cents), [10_000]);
});

test("income search handles Unicode case and aggregation", async () => {
  const { sqlite, db } = database();
  const insert = sqlite.prepare("INSERT INTO incomes (user_id, date, amount_cents, source, note) VALUES (?, ?, ?, ?, ?)");
  insert.run(1, "2026-07-01", 10_000, "JYVÄSKYLÄ Client", "Consulting");
  insert.run(1, "2026-07-02", 20_000, "Helsinki Client", "Consulting");
  insert.run(1, "2026-07-03", 30_000, "İSTANBUL Client", "Consulting");
  insert.run(1, "2026-07-04", 40_000, "Straße Client", "Consulting");

  const result = await runIncomeQuery(db, 1, { where: { source_like: "jyväskylä" }, select: ["sum", "count"] });
  assert.deepEqual(result.rows.map(row => ({ ...row })), [{ sum: 10_000, count: 1 }]);
  assert.deepEqual((await runIncomeQuery(db, 1, { where: { source_like: "istanbul" } })).rows.length, 1);
  assert.deepEqual((await runIncomeQuery(db, 1, { where: { source_like: "STRASSE" } })).rows.length, 1);
  const ranked = await runIncomeQuery(db, 1, {
    where: { note_like: "consulting" },
    group_by: ["source"],
    select: ["sum"],
    order_by: { col: "sum", dir: "desc" },
    limit: 1,
  });
  assert.deepEqual(ranked.rows.map(row => ({ ...row })), [{ source: "Straße Client", sum: 40_000 }]);
});

test("invalid expense taxonomy filters fail instead of broadening", async () => {
  const { sqlite, db } = database();
  sqlite.prepare("INSERT INTO expenses (user_id, date, amount_cents, category, subcategory) VALUES (?, ?, ?, ?, ?)")
    .run(1, "2026-07-01", 5_000, "Essentials", "Groceries");
  await assert.rejects(() => runExpenseQuery(db, 1, { where: { category_in: ["Not a category"] }, select: ["sum"] }), /unknown value/);
});

test("unknown query fields fail instead of broadening", async () => {
  const { db } = database();
  await assert.rejects(() => runExpenseQuery(db, 1, { where: { category: "Essentials" } }), /unknown field category/);
  await assert.rejects(() => runIncomeQuery(db, 1, { mystery: true }), /unknown field mystery/);
  await assert.rejects(() => runCashflowQuery(db, 1, { where: { date_from: "2026-01-01" } }), /unknown field where/);
});

test("ordering must address a returned column", async () => {
  const { db } = database();
  await assert.rejects(
    () => runIncomeQuery(db, 1, { group_by: ["source"], select: ["sum"], order_by: { col: "amount_cents" } }),
    /present in the query result/,
  );
  await assert.rejects(
    () => runIncomeQuery(db, 1, { order_by: { dir: "asc" } }),
    /order_by.col is required/,
  );
});

test("query dates must be real calendar dates", async () => {
  const { db } = database();
  await runIncomeQuery(db, 1, { where: { date_from: "2024-02-29" } });
  await assert.rejects(() => runIncomeQuery(db, 1, { where: { date_from: "2026-02-29" } }), /valid YYYY-MM-DD/);
  await assert.rejects(() => runCashflowQuery(db, 1, { date_to: "2026-13-01" }), /valid YYYY-MM-DD/);
});

test("cashflow calculates totals and monthly net without model arithmetic", async () => {
  const { sqlite, db } = database();
  sqlite.prepare("INSERT INTO incomes (user_id, date, amount_cents, source) VALUES (?, ?, ?, ?)")
    .run(1, "2026-06-01", 200_000, "Salary");
  sqlite.prepare("INSERT INTO incomes (user_id, date, amount_cents, source) VALUES (?, ?, ?, ?)")
    .run(1, "2026-07-01", 210_000, "Salary");
  sqlite.prepare("INSERT INTO expenses (user_id, date, amount_cents, category, subcategory) VALUES (?, ?, ?, ?, ?)")
    .run(1, "2026-06-02", 50_000, "Essentials", "Rent/Mortgage");
  sqlite.prepare("INSERT INTO expenses (user_id, date, amount_cents, category, subcategory) VALUES (?, ?, ?, ?, ?)")
    .run(1, "2026-07-02", 60_000, "Essentials", "Rent/Mortgage");
  sqlite.prepare("INSERT INTO incomes (user_id, date, amount_cents, source) VALUES (?, ?, ?, ?)")
    .run(2, "2026-07-01", 99_000_000, "Other user");

  assert.deepEqual((await runCashflowQuery(db, 1, {})).rows.map(row => ({ ...row })), [{ income_cents: 410_000, expense_cents: 110_000, net_cents: 300_000 }]);
  assert.deepEqual((await runCashflowQuery(db, 1, { group_by: "month" })).rows.map(row => ({ ...row })), [
    { month: "2026-06", income_cents: 200_000, expense_cents: 50_000, net_cents: 150_000 },
    { month: "2026-07", income_cents: 210_000, expense_cents: 60_000, net_cents: 150_000 },
  ]);
  assert.deepEqual((await runCashflowQuery(db, 1, { date_to: "2026-06-30" })).rows.map(row => ({ ...row })), [
    { income_cents: 200_000, expense_cents: 50_000, net_cents: 150_000 },
  ]);
});
