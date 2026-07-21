import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { cashOverview, chartView, validMonth } from "../src/reports.ts";
import { localDate } from "../src/time.ts";

const database = () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT NOT NULL,
      source TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE incomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      source TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({
        first: () => sqlite.prepare(sql).get(...params) ?? null,
        all: () => ({ results: sqlite.prepare(sql).all(...params) }),
      }),
    }),
  } as unknown as D1Database;
  const income = (userId: number, date: string, cents: number) =>
    sqlite.prepare("INSERT INTO incomes (user_id, date, amount_cents) VALUES (?, ?, ?)").run(userId, date, cents);
  const expense = (userId: number, date: string, cents: number, category: string, subcategory: string) =>
    sqlite.prepare("INSERT INTO expenses (user_id, date, amount_cents, category, subcategory) VALUES (?, ?, ?, ?, ?)")
      .run(userId, date, cents, category, subcategory);
  return { db, income, expense };
};

const user = { id: 1, currency: "EUR", timezone: "Europe/Helsinki" };
const now = new Date("2026-07-21T12:00:00Z");

const configFrom = (url: string) => JSON.parse(new URL(url).searchParams.get("c")!);

test("uses each user's calendar date and validates report months", () => {
  assert.equal(localDate("Europe/Helsinki", new Date("2026-12-31T22:30:00Z")), "2027-01-01");
  assert.equal(localDate("America/New_York", new Date("2026-12-31T22:30:00Z")), "2026-12-31");
  assert.equal(validMonth("2026-07"), true);
  assert.equal(validMonth("2026-00"), false);
  assert.equal(validMonth("2026-13"), false);
  assert.equal(validMonth("July"), false);
});

test("cash overview uses exact cutoffs and top five subcategory percentages", async () => {
  const { db, income, expense } = database();
  income(1, "2026-06-10", 200_000);
  expense(1, "2026-06-11", 50_000, "Essentials", "Rent/Mortgage");
  income(1, "2026-07-20", 300_000);
  income(1, "2026-07-25", 900_000);
  expense(1, "2026-07-21", 40_000, "Essentials", "Groceries");
  expense(1, "2026-07-20", 20_000, "Eating Out", "Restaurant");
  expense(1, "2026-07-19", 15_000, "Transportation", "Fuel");
  expense(1, "2026-07-18", 10_000, "Subscriptions", "Software & Apps");
  expense(1, "2026-07-17", 8_000, "Lifestyle & Leisure", "Entertainment");
  expense(1, "2026-07-16", 7_000, "Other", "Miscellaneous");
  expense(1, "2026-07-25", 500_000, "Travel", "Accommodation");
  income(2, "2026-07-20", 99_000_000);

  const current = await cashOverview(db, user, undefined, now);
  assert.match(current, /Balance: 3500\.00 EUR/);
  assert.match(current, /Income: 3000\.00 EUR/);
  assert.match(current, /Expenses: 1000\.00 EUR/);
  assert.match(current, /Net: \+2000\.00 EUR/);
  assert.match(current, /Essentials \/ Groceries: 400\.00 EUR  40%/);
  assert.doesNotMatch(current, /Other \/ Miscellaneous/);
  assert.doesNotMatch(current, /Travel \/ Accommodation/);
  assert.match(current, /Projected expenses:/);

  const historical = await cashOverview(db, user, "2026-06", now);
  assert.match(historical, /Balance through 2026-06: 1500\.00 EUR/);
  assert.match(historical, /Net: \+1500\.00 EUR/);
  assert.doesNotMatch(historical, /Burn:/);
  assert.doesNotMatch(historical, /Projected expenses:/);
});

test("cash trajectory fills months, negates expenses, and carries opening balance", async () => {
  const { db, income, expense } = database();
  income(1, "2025-07-01", 100_000);
  expense(1, "2025-07-02", 20_000, "Essentials", "Groceries");
  income(1, "2025-08-10", 10_000);
  expense(1, "2025-08-11", 2_000, "Eating Out", "Cafe");
  income(1, "2026-07-20", 5_000);
  expense(1, "2026-07-21", 1_000, "Transportation", "Fuel");
  expense(1, "2026-07-25", 90_000, "Travel", "Accommodation");
  income(2, "2026-07-20", 50_000_000);

  const view = await chartView(db, user, [], now);
  assert.ok("url" in view);
  const config = configFrom(view.url);
  assert.equal(config.data.labels.length, 12);
  assert.equal(config.data.labels.at(-1), "Jul*");
  assert.equal(config.data.datasets[0].data[0], 100);
  assert.equal(config.data.datasets[1].data[0], -20);
  assert.equal(config.data.datasets[1].data.at(-1), -10);
  assert.equal(config.data.datasets[2].data[0], 880);
  assert.equal(config.data.datasets[2].data.at(-1), 920);
  assert.match(view.caption, /12-month net \+120\.00 EUR/);
  assert.match(config.data.datasets[0].backgroundColor.at(-1), /0\.38/);
});

test("spending chart chooses five pairs, groups Other, and compares complete months", async () => {
  const { db, expense } = database();
  const pairs = [
    ["Essentials", "Groceries"],
    ["Eating Out", "Restaurant"],
    ["Transportation", "Fuel"],
    ["Subscriptions", "Software & Apps"],
    ["Lifestyle & Leisure", "Entertainment"],
    ["Other", "Miscellaneous"],
  ] as const;
  pairs.forEach(([category, subcategory], index) => {
    expense(1, "2026-05-10", (6 - index) * 1_000, category, subcategory);
    expense(1, "2026-06-10", (6 - index) * 1_500, category, subcategory);
  });
  expense(1, "2026-07-20", 2_000, "Essentials", "Groceries");
  expense(2, "2026-06-10", 99_000_000, "Travel", "Accommodation");

  const view = await chartView(db, user, ["spending"], now);
  assert.ok("url" in view);
  const config = configFrom(view.url);
  assert.equal(config.data.datasets.length, 6);
  assert.equal(config.data.datasets.at(-1).label, "Other");
  assert.equal(config.data.labels.at(-1), "Jul*");
  assert.match(view.caption, /Largest change from May 2026 to Jun 2026/);
  assert.match(view.caption, /Essentials \/ Groceries \+30\.00 EUR/);
  assert.match(config.data.datasets[0].backgroundColor.at(-1), /0\.38/);
});

test("spending caption finds pair changes hidden inside Other", async () => {
  const { db, expense } = database();
  const stable = [
    ["Essentials", "Groceries"],
    ["Eating Out", "Restaurant"],
    ["Transportation", "Fuel"],
    ["Subscriptions", "Software & Apps"],
    ["Lifestyle & Leisure", "Entertainment"],
  ] as const;
  stable.forEach(([category, subcategory], index) => {
    expense(1, "2026-05-10", 20_000 - index * 1_000, category, subcategory);
    expense(1, "2026-06-10", 20_000 - index * 1_000, category, subcategory);
  });
  expense(1, "2026-05-10", 5_000, "Other", "Miscellaneous");
  expense(1, "2026-06-10", 6_000, "Work", "Office Supplies");

  const view = await chartView(db, user, ["spending"], now);
  assert.ok("url" in view);
  assert.match(view.caption, /Work \/ Office Supplies \+60\.00 EUR/);
});

test("chart rejects unsupported modes", async () => {
  const { db } = database();
  assert.deepEqual(await chartView(db, user, ["pie"], now), { text: "Usage: /chart [spending]" });
  assert.deepEqual(await chartView(db, user, ["spending", "12"], now), { text: "Usage: /chart [spending]" });
});
