import { CATEGORIES, canonicalCategory, canonicalSubcategory } from "./taxonomy.ts";
import { isIsoDate } from "./time.ts";

type Aggregate = "sum" | "count" | "avg" | "min" | "max";
type CommonGroup = "source" | "date" | "month" | "weekday";
type ExpenseGroup = CommonGroup | "category" | "subcategory";
type CommonOrder = Aggregate | "date" | "amount_cents" | "source";
type ExpenseOrder = CommonOrder | "category" | "subcategory";

type CommonWhere = {
  date_from?: string;
  date_to?: string;
  min_cents?: number;
  max_cents?: number;
  note_like?: string;
  source_like?: string;
};

export type ExpenseQueryArgs = {
  where?: CommonWhere & {
    category_in?: string[];
    category_not_in?: string[];
    subcategory_in?: string[];
    subcategory_not_in?: string[];
  };
  group_by?: ExpenseGroup[];
  select?: Aggregate[];
  order_by?: { col: ExpenseOrder; dir?: "asc" | "desc" };
  limit?: number;
};

export type IncomeQueryArgs = {
  where?: CommonWhere;
  group_by?: CommonGroup[];
  select?: Aggregate[];
  order_by?: { col: CommonOrder; dir?: "asc" | "desc" };
  limit?: number;
};

export type CashflowQueryArgs = {
  date_from?: string;
  date_to?: string;
  group_by?: "month";
};

const AGG_SQL: Record<Aggregate, string> = {
  sum: "COALESCE(SUM(amount_cents), 0)",
  count: "COUNT(*)",
  avg: "COALESCE(CAST(AVG(amount_cents) AS INTEGER), 0)",
  min: "COALESCE(MIN(amount_cents), 0)",
  max: "COALESCE(MAX(amount_cents), 0)",
};

const COMMON_GROUP_SQL: Record<CommonGroup, string> = {
  source: "source",
  date: "date",
  month: "strftime('%Y-%m', date)",
  weekday: "strftime('%w', date)",
};

const EXPENSE_GROUP_SQL: Record<ExpenseGroup, string> = {
  ...COMMON_GROUP_SQL,
  category: "category",
  subcategory: "subcategory",
};

const AGGREGATES = new Set(Object.keys(AGG_SQL));
const COMMON_ORDERS = new Set(["sum", "count", "avg", "min", "max", "date", "amount_cents", "source"]);
const EXPENSE_ORDERS = new Set([...COMMON_ORDERS, "category", "subcategory"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const QUERY_KEYS = new Set(["where", "group_by", "select", "order_by", "limit"]);
const COMMON_WHERE_KEYS = new Set(["date_from", "date_to", "min_cents", "max_cents", "note_like", "source_like"]);
const EXPENSE_WHERE_KEYS = new Set([...COMMON_WHERE_KEYS, "category_in", "category_not_in", "subcategory_in", "subcategory_not_in"]);
const ORDER_KEYS = new Set(["col", "dir"]);
const CASHFLOW_KEYS = new Set(["date_from", "date_to", "group_by"]);

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
};

const allowOnly = (value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string) => {
  const unknown = Object.keys(value).find(key => !allowed.has(key));
  if (unknown) throw new Error(`${name} contains unknown field ${unknown}`);
};

const optionalString = (value: unknown, name: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
};

const optionalInteger = (value: unknown, name: string) => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value as number;
};

const enumArray = <T extends string>(value: unknown, allowed: ReadonlySet<string>, name: string): T[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !allowed.has(item))) {
    throw new Error(`${name} contains an invalid value`);
  }
  return [...new Set(value)] as T[];
};

const stringArray = (value: unknown, name: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${name} must contain strings`);
  return value;
};

const pushCommonWhere = (where: string[], params: (string | number)[], raw: Record<string, unknown>) => {
  const dateFrom = optionalString(raw.date_from, "date_from");
  const dateTo = optionalString(raw.date_to, "date_to");
  if (dateFrom && !isIsoDate(dateFrom)) throw new Error("date_from must be a valid YYYY-MM-DD date");
  if (dateTo && !isIsoDate(dateTo)) throw new Error("date_to must be a valid YYYY-MM-DD date");
  if (dateFrom) { where.push("date >= ?"); params.push(dateFrom); }
  if (dateTo) { where.push("date <= ?"); params.push(dateTo); }
  const min = optionalInteger(raw.min_cents, "min_cents");
  const max = optionalInteger(raw.max_cents, "max_cents");
  if (min !== undefined) { where.push("amount_cents >= ?"); params.push(min); }
  if (max !== undefined) { where.push("amount_cents <= ?"); params.push(max); }
};

const normalized = (value: string) => value
  .normalize("NFKC")
  .toLocaleUpperCase()
  .toLocaleLowerCase()
  .replaceAll("\u0307", "");

const textMatches = (row: Record<string, unknown>, noteLike?: string, sourceLike?: string) =>
  (!noteLike || normalized(String(row.note ?? "")).includes(normalized(noteLike)))
  && (!sourceLike || normalized(String(row.source ?? "")).includes(normalized(sourceLike)));

const groupValue = (row: Record<string, unknown>, group: string): unknown => {
  if (group === "month") return String(row.date).slice(0, 7);
  if (group === "weekday") return String(new Date(`${row.date}T00:00:00Z`).getUTCDay());
  return row[group];
};

const aggregateRows = (rows: Record<string, unknown>[], groups: string[], aggregates: Aggregate[]) => {
  const buckets = new Map<string, { values: Record<string, unknown>; rows: Record<string, unknown>[] }>();
  if (!groups.length) buckets.set("", { values: {}, rows: [] });
  for (const row of rows) {
    const values = Object.fromEntries(groups.map(group => [group, groupValue(row, group)]));
    const key = groups.length ? JSON.stringify(Object.values(values)) : "";
    const bucket = buckets.get(key) ?? { values, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(bucket => {
    const amounts = bucket.rows.map(row => Number(row.amount_cents));
    const sum = amounts.reduce((total, amount) => total + amount, 0);
    const values: Record<Aggregate, number> = {
      sum,
      count: amounts.length,
      avg: amounts.length ? Math.trunc(sum / amounts.length) : 0,
      min: amounts.length ? Math.min(...amounts) : 0,
      max: amounts.length ? Math.max(...amounts) : 0,
    };
    return { ...bucket.values, ...Object.fromEntries(aggregates.map(aggregate => [aggregate, values[aggregate]])) };
  });
};

const compareValues = (left: unknown, right: unknown) => {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  return left < right ? -1 : 1;
};

const canonicalSubAny = (value: string): string | null => {
  for (const category of CATEGORIES) {
    const subcategory = canonicalSubcategory(category, value);
    if (subcategory) return subcategory;
  }
  return null;
};

const pushCanonical = (
  where: string[], params: (string | number)[], column: string, raw: unknown,
  canonicalize: (value: string) => string | null, name: string, negate = false,
) => {
  const values = stringArray(raw, name);
  if (!values.length) return;
  const clean = values.map(canonicalize);
  if (clean.some(value => value === null)) throw new Error(`${name} contains an unknown value`);
  where.push(`${column} ${negate ? "NOT IN" : "IN"} (${clean.map(() => "?").join(", ")})`);
  params.push(...clean as string[]);
};

const runRecordQuery = async (
  database: D1Database,
  userId: number,
  table: "expenses" | "incomes",
  argsValue: unknown,
) => {
  const args = record(argsValue, "query");
  allowOnly(args, QUERY_KEYS, "query");
  const whereRaw = record(args.where, "where");
  allowOnly(whereRaw, table === "expenses" ? EXPENSE_WHERE_KEYS : COMMON_WHERE_KEYS, "where");
  const where = ["user_id = ?"];
  const params: (string | number)[] = [userId];
  pushCommonWhere(where, params, whereRaw);
  if (table === "expenses") {
    pushCanonical(where, params, "category", whereRaw.category_in, canonicalCategory, "category_in");
    pushCanonical(where, params, "category", whereRaw.category_not_in, canonicalCategory, "category_not_in", true);
    pushCanonical(where, params, "subcategory", whereRaw.subcategory_in, canonicalSubAny, "subcategory_in");
    pushCanonical(where, params, "subcategory", whereRaw.subcategory_not_in, canonicalSubAny, "subcategory_not_in", true);
  }

  const groupSql = table === "expenses" ? EXPENSE_GROUP_SQL : COMMON_GROUP_SQL;
  const groups = enumArray<string>(args.group_by, new Set(Object.keys(groupSql)), "group_by");
  const aggregates = enumArray<Aggregate>(args.select, AGGREGATES, "select");
  if (groups.length && !aggregates.length) aggregates.push("sum");
  const noteLike = optionalString(whereRaw.note_like, "note_like");
  const sourceLike = optionalString(whereRaw.source_like, "source_like");
  const usesTextSearch = Boolean(noteLike || sourceLike);
  const columns = groups.length || aggregates.length
    ? [...groups.map(group => `${groupSql[group as keyof typeof groupSql]} AS ${group}`), ...aggregates.map(aggregate => `${AGG_SQL[aggregate]} AS ${aggregate}`)]
    : table === "expenses"
      ? ["id", "date", "amount_cents", "category", "subcategory", "source", "note"]
      : ["id", "date", "amount_cents", "source", "note"];

  let sql = `SELECT ${columns.join(", ")} FROM ${table} WHERE ${where.join(" AND ")}`;
  if (groups.length) sql += ` GROUP BY ${groups.join(", ")}`;
  const order = record(args.order_by, "order_by");
  allowOnly(order, ORDER_KEYS, "order_by");
  const orderColumn = optionalString(order.col, "order_by.col");
  const allowedOrders = table === "expenses" ? EXPENSE_ORDERS : COMMON_ORDERS;
  const direction = optionalString(order.dir, "order_by.dir");
  if (!orderColumn && direction) throw new Error("order_by.col is required");
  if (direction && direction !== "asc" && direction !== "desc") throw new Error("order_by.dir must be asc or desc");
  if (orderColumn) {
    if (!allowedOrders.has(orderColumn)) throw new Error("order_by.col contains an invalid value");
    const outputColumns = groups.length || aggregates.length
      ? new Set([...groups, ...aggregates])
      : new Set(table === "expenses"
        ? ["id", "date", "amount_cents", "category", "subcategory", "source", "note"]
        : ["id", "date", "amount_cents", "source", "note"]);
    if (!outputColumns.has(orderColumn)) throw new Error("order_by.col must be present in the query result");
    if (!usesTextSearch) sql += ` ORDER BY ${orderColumn} ${direction === "asc" ? "ASC" : "DESC"}`;
  } else if (!groups.length) {
    if (!usesTextSearch) sql += " ORDER BY date DESC, id DESC";
  }
  const requestedLimit = optionalInteger(args.limit, "limit") ?? DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, requestedLimit), MAX_LIMIT);
  if (!usesTextSearch) {
    sql += " LIMIT ?";
    params.push(limit);
  } else {
    const rawColumns = table === "expenses"
      ? ["id", "date", "amount_cents", "category", "subcategory", "source", "note"]
      : ["id", "date", "amount_cents", "source", "note"];
    sql = `SELECT ${rawColumns.join(", ")} FROM ${table} WHERE ${where.join(" AND ")}`;
  }
  const result = await database.prepare(sql).bind(...params).all();
  if (!usesTextSearch) return { rows: result.results };

  let rows = (result.results as Record<string, unknown>[]).filter(row => textMatches(row, noteLike, sourceLike));
  if (groups.length || aggregates.length) rows = aggregateRows(rows, groups, aggregates);
  if (orderColumn) {
    rows.sort((left, right) => compareValues(left[orderColumn], right[orderColumn]) * (direction === "asc" ? 1 : -1));
  } else if (!groups.length && !aggregates.length) {
    rows.sort((left, right) => compareValues(right.date, left.date) || compareValues(right.id, left.id));
  }
  return { rows: rows.slice(0, limit) };
};

export const runExpenseQuery = (database: D1Database, userId: number, args: unknown) =>
  runRecordQuery(database, userId, "expenses", args);

export const runIncomeQuery = (database: D1Database, userId: number, args: unknown) =>
  runRecordQuery(database, userId, "incomes", args);

export const runCashflowQuery = async (database: D1Database, userId: number, argsValue: unknown) => {
  const args = record(argsValue, "query");
  allowOnly(args, CASHFLOW_KEYS, "query");
  const dateFrom = optionalString(args.date_from, "date_from");
  const dateTo = optionalString(args.date_to, "date_to");
  if (dateFrom && !isIsoDate(dateFrom)) throw new Error("date_from must be a valid YYYY-MM-DD date");
  if (dateTo && !isIsoDate(dateTo)) throw new Error("date_to must be a valid YYYY-MM-DD date");
  if (args.group_by !== undefined && args.group_by !== "month") throw new Error("group_by must be month");
  const branch = (table: "incomes" | "expenses") => {
    const where = ["user_id = ?"];
    const params: (string | number)[] = [userId];
    if (dateFrom) { where.push("date >= ?"); params.push(dateFrom); }
    if (dateTo) { where.push("date <= ?"); params.push(dateTo); }
    return { sql: `SELECT date, amount_cents FROM ${table} WHERE ${where.join(" AND ")}`, params };
  };
  const incomes = branch("incomes");
  const expenses = branch("expenses");
  const grouped = args.group_by === "month";
  const sql = `WITH movements AS (
    SELECT date, amount_cents AS income_cents, 0 AS expense_cents FROM (${incomes.sql})
    UNION ALL
    SELECT date, 0 AS income_cents, amount_cents AS expense_cents FROM (${expenses.sql})
  )
  SELECT ${grouped ? "substr(date, 1, 7) AS month," : ""}
    COALESCE(SUM(income_cents), 0) AS income_cents,
    COALESCE(SUM(expense_cents), 0) AS expense_cents,
    COALESCE(SUM(income_cents), 0) - COALESCE(SUM(expense_cents), 0) AS net_cents
  FROM movements
  ${grouped ? "GROUP BY month ORDER BY month" : ""}`;
  const result = await database.prepare(sql).bind(...incomes.params, ...expenses.params).all();
  return { rows: result.results };
};
