import type { Category } from "./taxonomy";

export type Txn = {
  id: number;
  date: string;
  type: "expense" | "income";
  amount_cents: number;
  category: Category | null;
  subcategory: string | null;
  source: string | null;
  note: string | null;
  created_at: string;
};

const EDITABLE = new Set(["date", "amount_cents", "category", "subcategory", "source", "note"]);

export const insert = (db: D1Database, type: "expense" | "income", t: Omit<Txn, "id" | "type" | "created_at">) =>
  db.prepare(
    "INSERT INTO transactions (date, type, amount_cents, category, subcategory, source, note) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).bind(t.date, type, t.amount_cents, t.category, t.subcategory, t.source, t.note).first<{ id: number }>();

export const update = (db: D1Database, id: number, field: string, value: string | number | null) => {
  if (!EDITABLE.has(field)) throw new Error(`field not editable: ${field}`);
  return db.prepare(`UPDATE transactions SET ${field}=? WHERE id=?`).bind(value, id).run();
};

export const remove = (db: D1Database, id: number) =>
  db.prepare("DELETE FROM transactions WHERE id=?").bind(id).run();

export const get = (db: D1Database, id: number) =>
  db.prepare("SELECT * FROM transactions WHERE id=?").bind(id).first<Txn>();

export const recent = (db: D1Database, limit = 10) =>
  db.prepare("SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT ?").bind(limit).all<Txn>();

export const cash = async (db: D1Database) =>
  (await db.prepare(
    "SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_cents ELSE -amount_cents END), 0) AS cents FROM transactions"
  ).first<{ cents: number }>())?.cents ?? 0;

export const burn = async (db: D1Database, days: number) =>
  (await db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM transactions WHERE type='expense' AND date >= date('now', ?)"
  ).bind(`-${days} days`).first<{ cents: number }>())?.cents ?? 0;

export const trackPrompt = (db: D1Database, chat_id: number, message_id: number, txn_id: number) =>
  db.prepare("INSERT INTO pending_edits VALUES (?, ?, ?, datetime('now', '+10 minutes'))")
    .bind(chat_id, message_id, txn_id).run();

export const dropPrompt = (db: D1Database, chat_id: number, message_id: number) =>
  db.prepare("DELETE FROM pending_edits WHERE chat_id=? AND message_id=?")
    .bind(chat_id, message_id).run();

export const sweep = (db: D1Database) =>
  db.prepare("DELETE FROM pending_edits WHERE expires_at < datetime('now') RETURNING chat_id, message_id")
    .all<{ chat_id: number; message_id: number }>();

export const monthSummary = (db: D1Database, ym: string) =>
  db.prepare(
    "SELECT category, SUM(amount_cents) AS cents, COUNT(*) AS n FROM transactions WHERE type='expense' AND substr(date, 1, 7) = ? GROUP BY category ORDER BY cents DESC"
  ).bind(ym).all<{ category: string; cents: number; n: number }>();

export const all = (db: D1Database) =>
  db.prepare("SELECT * FROM transactions ORDER BY id").all<Txn>();
