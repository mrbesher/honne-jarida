import type { Category } from "./taxonomy";

export type Status = "pending" | "approved" | "admin";

export type User = {
  id: number;
  status: Status;
  currency: string;
  timezone: string | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  requested_at: string;
};

export type Expense = {
  id: number;
  user_id: number;
  date: string;
  amount_cents: number;
  category: Category;
  subcategory: string;
  source: string | null;
  note: string | null;
  created_at: string;
};

export type Income = {
  id: number;
  user_id: number;
  date: string;
  amount_cents: number;
  source: string | null;
  note: string | null;
  created_at: string;
};

export type ReceiptJob = {
  update_id: number;
  extracted_json: string;
  completed_at: string | null;
  created_at: string;
};

export type ReceiptRecord = {
  id: number;
  telegram_reply_message_id: number | null;
};

const EDITABLE = new Set(["date", "amount_cents", "category", "subcategory", "source", "note"]);

export const getUser = (db: D1Database, id: number) =>
  db.prepare("SELECT * FROM users WHERE id=?").bind(id).first<User>();

export const insertPendingUser = (
  db: D1Database,
  u: { id: number; currency: string; timezone: string; first_name: string | null; last_name: string | null; username: string | null },
) =>
  db.prepare(
    "INSERT INTO users (id, status, currency, timezone, first_name, last_name, username) VALUES (?, 'pending', ?, ?, ?, ?, ?)"
  ).bind(u.id, u.currency, u.timezone, u.first_name, u.last_name, u.username).run();

export const setTimezone = (db: D1Database, id: number, timezone: string) =>
  db.prepare("UPDATE users SET timezone=? WHERE id=? AND status IN ('approved', 'admin')").bind(timezone, id).run();

export const approveUser = (db: D1Database, id: number) =>
  db.prepare("UPDATE users SET status='approved' WHERE id=? AND status='pending'").bind(id).run();

export const listPending = (db: D1Database) =>
  db.prepare("SELECT * FROM users WHERE status='pending' ORDER BY requested_at").all<User>();

export const sweepPendingUsers = (db: D1Database) =>
  db.prepare("DELETE FROM users WHERE status='pending' AND requested_at < datetime('now', '-3 days')").run();

export const activeUsers = (db: D1Database) =>
  db.prepare("SELECT * FROM users WHERE status IN ('approved', 'admin')").all<User>();

export const insertExpense = (db: D1Database, userId: number, e: Omit<Expense, "id" | "user_id" | "created_at">) =>
  db.prepare(
    "INSERT INTO expenses (user_id, date, amount_cents, category, subcategory, source, note) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).bind(userId, e.date, e.amount_cents, e.category, e.subcategory, e.source, e.note).first<{ id: number }>();

export const duplicateExpense = (
  db: D1Database,
  userId: number,
  id: number,
  e: Omit<Expense, "id" | "user_id" | "created_at">,
) => db.prepare(
  `SELECT id FROM expenses
   WHERE user_id=? AND date=? AND amount_cents=? AND category=? AND subcategory=?
     AND source IS ? AND note IS ? AND id<>?
   ORDER BY id DESC LIMIT 1`
).bind(userId, e.date, e.amount_cents, e.category, e.subcategory, e.source, e.note, id).first<{ id: number }>();

export const insertIncome = (db: D1Database, userId: number, i: Omit<Income, "id" | "user_id" | "created_at">) =>
  db.prepare(
    "INSERT INTO incomes (user_id, date, amount_cents, source, note) VALUES (?, ?, ?, ?, ?) RETURNING id"
  ).bind(userId, i.date, i.amount_cents, i.source, i.note).first<{ id: number }>();

export const duplicateIncome = (
  db: D1Database,
  userId: number,
  id: number,
  i: Omit<Income, "id" | "user_id" | "created_at">,
) => db.prepare(
  `SELECT id FROM incomes
   WHERE user_id=? AND date=? AND amount_cents=? AND source IS ? AND note IS ? AND id<>?
   ORDER BY id DESC LIMIT 1`
).bind(userId, i.date, i.amount_cents, i.source, i.note, id).first<{ id: number }>();

export const receiptJob = (db: D1Database, updateId: number) =>
  db.prepare("SELECT * FROM receipt_jobs WHERE update_id=?").bind(updateId).first<ReceiptJob>();

export const saveReceiptExtraction = (db: D1Database, updateId: number, extractedJson: string) =>
  db.prepare(
    "INSERT INTO receipt_jobs (update_id, extracted_json) VALUES (?, ?) ON CONFLICT(update_id) DO NOTHING"
  ).bind(updateId, extractedJson).run();

export const completeReceiptJob = (db: D1Database, updateId: number) =>
  db.prepare("UPDATE receipt_jobs SET completed_at=datetime('now') WHERE update_id=?")
    .bind(updateId).run();

export const insertReceiptExpense = (
  db: D1Database,
  userId: number,
  updateId: number,
  itemIndex: number,
  e: Omit<Expense, "id" | "user_id" | "created_at">,
) =>
  db.prepare(
    `INSERT OR IGNORE INTO expenses
      (user_id, date, amount_cents, category, subcategory, source, note, telegram_update_id, telegram_item_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, telegram_reply_message_id`
  ).bind(userId, e.date, e.amount_cents, e.category, e.subcategory, e.source, e.note, updateId, itemIndex)
    .first<ReceiptRecord>();

export const receiptExpense = (db: D1Database, updateId: number, itemIndex: number) =>
  db.prepare(
    "SELECT id, telegram_reply_message_id FROM expenses WHERE telegram_update_id=? AND telegram_item_index=?"
  ).bind(updateId, itemIndex).first<ReceiptRecord>();

export const insertReceiptIncome = (
  db: D1Database,
  userId: number,
  updateId: number,
  itemIndex: number,
  i: Omit<Income, "id" | "user_id" | "created_at">,
) =>
  db.prepare(
    `INSERT OR IGNORE INTO incomes
      (user_id, date, amount_cents, source, note, telegram_update_id, telegram_item_index)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, telegram_reply_message_id`
  ).bind(userId, i.date, i.amount_cents, i.source, i.note, updateId, itemIndex)
    .first<ReceiptRecord>();

export const receiptIncome = (db: D1Database, updateId: number, itemIndex: number) =>
  db.prepare(
    "SELECT id, telegram_reply_message_id FROM incomes WHERE telegram_update_id=? AND telegram_item_index=?"
  ).bind(updateId, itemIndex).first<ReceiptRecord>();

export const trackReceiptExpenseReply = (
  db: D1Database,
  id: number,
  chatId: number,
  messageId: number,
) => db.batch([
  db.prepare(
    "UPDATE expenses SET telegram_reply_message_id=? WHERE id=? AND telegram_reply_message_id IS NULL"
  ).bind(messageId, id),
  db.prepare(
    "INSERT OR IGNORE INTO pending_prompts VALUES (?, ?, datetime('now', '+10 minutes'))"
  ).bind(chatId, messageId),
]);

export const trackReceiptIncomeReply = (
  db: D1Database,
  id: number,
  chatId: number,
  messageId: number,
) => db.batch([
  db.prepare(
    "UPDATE incomes SET telegram_reply_message_id=? WHERE id=? AND telegram_reply_message_id IS NULL"
  ).bind(messageId, id),
  db.prepare(
    "INSERT OR IGNORE INTO pending_prompts VALUES (?, ?, datetime('now', '+10 minutes'))"
  ).bind(chatId, messageId),
]);

export const update = (db: D1Database, userId: number, id: number, field: string, value: string | number | null) => {
  if (!EDITABLE.has(field)) throw new Error(`field not editable: ${field}`);
  return db.prepare(`UPDATE expenses SET ${field}=? WHERE id=? AND user_id=?`).bind(value, id, userId).run();
};

export const setCategoryAndSub = (db: D1Database, userId: number, id: number, cat: Category, sub: string) =>
  db.prepare("UPDATE expenses SET category=?, subcategory=? WHERE id=? AND user_id=?").bind(cat, sub, id, userId).run();

export const remove = (db: D1Database, userId: number, id: number) =>
  db.prepare("DELETE FROM expenses WHERE id=? AND user_id=?").bind(id, userId).run();

export const removeIncome = (db: D1Database, userId: number, id: number) =>
  db.prepare("DELETE FROM incomes WHERE id=? AND user_id=?").bind(id, userId).run();

export const get = (db: D1Database, userId: number, id: number) =>
  db.prepare("SELECT * FROM expenses WHERE id=? AND user_id=?").bind(id, userId).first<Expense>();

export const recentExpenses = (db: D1Database, userId: number, limit: number) =>
  db.prepare("SELECT * FROM expenses WHERE user_id=? ORDER BY date DESC, id DESC LIMIT ?").bind(userId, limit).all<Expense>();

export const recentIncomes = (db: D1Database, userId: number, limit: number) =>
  db.prepare("SELECT * FROM incomes WHERE user_id=? ORDER BY date DESC, id DESC LIMIT ?").bind(userId, limit).all<Income>();

export const cash = async (db: D1Database, userId: number) => {
  const inc = await db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM incomes WHERE user_id=?").bind(userId).first<{ cents: number }>();
  const exp = await db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM expenses WHERE user_id=?").bind(userId).first<{ cents: number }>();
  return (inc?.cents ?? 0) - (exp?.cents ?? 0);
};

export type CashTotals = { income_cents: number; expense_cents: number };

export const cashTotalsBefore = async (db: D1Database, userId: number, before: string): Promise<CashTotals> =>
  (await db.prepare(
    `SELECT
       (SELECT COALESCE(SUM(amount_cents), 0) FROM incomes WHERE user_id=?1 AND date < ?2) AS income_cents,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM expenses WHERE user_id=?1 AND date < ?2) AS expense_cents`
  ).bind(userId, before).first<CashTotals>()) ?? { income_cents: 0, expense_cents: 0 };

export const cashTotalsBetween = async (db: D1Database, userId: number, from: string, before: string): Promise<CashTotals> =>
  (await db.prepare(
    `SELECT
       (SELECT COALESCE(SUM(amount_cents), 0) FROM incomes WHERE user_id=?1 AND date >= ?2 AND date < ?3) AS income_cents,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM expenses WHERE user_id=?1 AND date >= ?2 AND date < ?3) AS expense_cents`
  ).bind(userId, from, before).first<CashTotals>()) ?? { income_cents: 0, expense_cents: 0 };

export const topSubcategoriesBetween = (db: D1Database, userId: number, from: string, before: string, limit = 5) =>
  db.prepare(
    `SELECT category, subcategory, SUM(amount_cents) AS cents
     FROM expenses
     WHERE user_id=? AND date >= ? AND date < ?
     GROUP BY category, subcategory
     ORDER BY cents DESC, category, subcategory
     LIMIT ?`
  ).bind(userId, from, before, limit).all<{ category: string; subcategory: string; cents: number }>();

export const monthlyCashflowBetween = (db: D1Database, userId: number, from: string, before: string) =>
  db.prepare(
    `SELECT ym, SUM(income_cents) AS income_cents, SUM(expense_cents) AS expense_cents
     FROM (
       SELECT substr(date, 1, 7) AS ym, SUM(amount_cents) AS income_cents, 0 AS expense_cents
       FROM incomes
       WHERE user_id=?1 AND date >= ?2 AND date < ?3
       GROUP BY ym
       UNION ALL
       SELECT substr(date, 1, 7) AS ym, 0 AS income_cents, SUM(amount_cents) AS expense_cents
       FROM expenses
       WHERE user_id=?1 AND date >= ?2 AND date < ?3
       GROUP BY ym
     )
     GROUP BY ym
     ORDER BY ym`
  ).bind(userId, from, before).all<{ ym: string; income_cents: number; expense_cents: number }>();

export const monthlySubcategoriesBetween = (db: D1Database, userId: number, from: string, before: string) =>
  db.prepare(
    `SELECT substr(date, 1, 7) AS ym, category, subcategory, SUM(amount_cents) AS cents
     FROM expenses
     WHERE user_id=? AND date >= ? AND date < ?
     GROUP BY ym, category, subcategory
     ORDER BY ym, cents DESC`
  ).bind(userId, from, before).all<{ ym: string; category: string; subcategory: string; cents: number }>();

export const burn = async (db: D1Database, userId: number, days: number, today: string) =>
  (await db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM expenses WHERE user_id=? AND date >= date(?, ?) AND date <= ?"
  ).bind(userId, today, `-${days} days`, today).first<{ cents: number }>())?.cents ?? 0;

export const expectedMonthlyBurn = async (db: D1Database, userId: number, months: number, currentYm: string): Promise<number> => {
  const endYm = currentYm;
  const [year, month] = endYm.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1 - months, 1)).toISOString().slice(0, 10);
  const { results } = await db.prepare(
    `SELECT strftime('%Y-%m', date) AS ym, SUM(amount_cents) AS cents
     FROM expenses
     WHERE user_id=?
       AND date >= ?
       AND date < ?
     GROUP BY ym`
  ).bind(userId, start, `${endYm}-01`).all<{ ym: string; cents: number }>();
  const got = new Map(results.map(r => [r.ym, r.cents]));
  let weighted = 0;
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(year, month - 1 - (months - i), 1));
    const ym = d.toISOString().slice(0, 7);
    weighted += (got.get(ym) ?? 0) * (i + 1);
  }
  return weighted / (months * (months + 1) / 2);
};

export const trackPrompt = (db: D1Database, chat_id: number, message_id: number) =>
  db.prepare("INSERT INTO pending_prompts VALUES (?, ?, datetime('now', '+10 minutes'))")
    .bind(chat_id, message_id).run();

export const activePrompt = (db: D1Database, chat_id: number, message_id: number) =>
  db.prepare(
    "SELECT 1 AS active FROM pending_prompts WHERE chat_id=? AND message_id=? AND expires_at >= datetime('now')"
  ).bind(chat_id, message_id).first<{ active: number }>();

export const dropPrompt = (db: D1Database, chat_id: number, message_id: number) =>
  db.prepare("DELETE FROM pending_prompts WHERE chat_id=? AND message_id=?")
    .bind(chat_id, message_id).run();

export const sweep = (db: D1Database) =>
  db.prepare("DELETE FROM pending_prompts WHERE expires_at < datetime('now') RETURNING chat_id, message_id")
    .all<{ chat_id: number; message_id: number }>();

export const monthSummary = (db: D1Database, userId: number, ym: string) =>
  db.prepare(
    "SELECT category, SUM(amount_cents) AS cents, COUNT(*) AS n FROM expenses WHERE user_id=? AND substr(date, 1, 7) = ? GROUP BY category ORDER BY cents DESC"
  ).bind(userId, ym).all<{ category: string; cents: number; n: number }>();

export const subcategorySummary = (db: D1Database, userId: number, ym: string) =>
  db.prepare(
    "SELECT category, subcategory, SUM(amount_cents) AS cents, COUNT(*) AS n FROM expenses WHERE user_id=? AND substr(date, 1, 7) = ? GROUP BY category, subcategory ORDER BY cents DESC"
  ).bind(userId, ym).all<{ category: string; subcategory: string; cents: number; n: number }>();

export const biggestInMonth = (db: D1Database, userId: number, ym: string, limit: number) =>
  db.prepare(
    "SELECT id, date, amount_cents, category, subcategory, note FROM expenses WHERE user_id=? AND substr(date, 1, 7) = ? ORDER BY amount_cents DESC LIMIT ?"
  ).bind(userId, ym, limit).all<{ id: number; date: string; amount_cents: number; category: string; subcategory: string; note: string | null }>();

export const subcatVsAvg = (db: D1Database, userId: number, ym: string, lookbackMonths: number, limit: number) =>
  db.prepare(
    `WITH window AS (
       SELECT category, subcategory, substr(date, 1, 7) AS ym, SUM(amount_cents) AS cents
       FROM expenses
       WHERE user_id=?1
         AND date >= date(?2 || '-01', '-' || ?3 || ' months')
         AND date <  date(?2 || '-01', '+1 month')
       GROUP BY category, subcategory, ym
     )
     SELECT category, subcategory,
       SUM(CASE WHEN ym = ?2 THEN cents ELSE 0 END) AS current_cents,
       CAST(SUM(CASE WHEN ym < ?2 THEN cents ELSE 0 END) * 1.0 / ?3 AS INTEGER) AS avg_cents
     FROM window
     GROUP BY category, subcategory
     HAVING current_cents > 0
     ORDER BY current_cents DESC
     LIMIT ?4`
  ).bind(userId, ym, lookbackMonths, limit)
    .all<{ category: string; subcategory: string; current_cents: number; avg_cents: number }>();

export const recurring = (db: D1Database, userId: number, floor: number, today: string) =>
  db.prepare(
    `SELECT category, subcategory,
       COUNT(*) AS n,
       CAST(AVG(amount_cents) AS INTEGER) AS avg_cents,
       MAX(note) AS note,
       MAX(date) AS last_date,
       (julianday(MAX(date)) - julianday(MIN(date))) / (COUNT(*) - 1) AS interval_days
     FROM expenses
     WHERE user_id=?1 AND date >= date(?3, '-3 months') AND date <= ?3
     GROUP BY category, subcategory
     HAVING COUNT(*) BETWEEN 3 AND 12
        AND (julianday(MAX(date)) - julianday(MIN(date))) / (COUNT(*) - 1) BETWEEN 22 AND 37
        AND (MAX(amount_cents) - MIN(amount_cents)) * 1.0 / AVG(amount_cents) < 0.15
        AND AVG(amount_cents) >= ?2
     ORDER BY MAX(date) DESC`
  ).bind(userId, floor, today).all<{ category: string; subcategory: string; n: number; avg_cents: number; note: string | null; last_date: string; interval_days: number }>();

export const allExpenses = (db: D1Database) =>
  db.prepare("SELECT * FROM expenses ORDER BY id").all<Expense>();

export const allIncomes = (db: D1Database) =>
  db.prepare("SELECT * FROM incomes ORDER BY id").all<Income>();
