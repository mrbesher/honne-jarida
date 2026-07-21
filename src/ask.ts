import type { User } from "./db.ts";
import * as llm from "./llm.ts";
import { runCashflowQuery, runExpenseQuery, runIncomeQuery } from "./query.ts";
import { TAXONOMY } from "./taxonomy.ts";
import { localDate } from "./time.ts";

type ZonedUser = User & { timezone: string };

const commonWhere = {
  type: "object",
  additionalProperties: false,
  properties: {
    date_from: { type: "string", description: "Inclusive ISO date YYYY-MM-DD" },
    date_to: { type: "string", description: "Inclusive ISO date YYYY-MM-DD" },
    min_cents: { type: "integer" },
    max_cents: { type: "integer" },
    note_like: { type: "string", description: "Literal case-insensitive substring of note" },
    source_like: { type: "string", description: "Literal case-insensitive substring of source" },
  },
};

const aggregates = ["sum", "count", "avg", "min", "max"];

const EXPENSE_TOOL: llm.Tool = {
  type: "function",
  function: {
    name: "query_expenses",
    description: "Read-only expense search and aggregation. Merchant or item text is usually in note; payment method or account is usually in source. note_like and source_like are literal case-insensitive substring searches. If both are supplied they must both match. Use separate calls to search either field. order_by.col must be a selected aggregate, active grouping key, or raw-row field. Raw rows are capped at 200.",
    parameters: {
      type: "object",
      properties: {
        where: {
          ...commonWhere,
          properties: {
            ...commonWhere.properties,
            category_in: { type: "array", items: { type: "string" } },
            category_not_in: { type: "array", items: { type: "string" } },
            subcategory_in: { type: "array", items: { type: "string" } },
            subcategory_not_in: { type: "array", items: { type: "string" } },
          },
        },
        group_by: { type: "array", items: { type: "string", enum: ["category", "subcategory", "source", "date", "month", "weekday"] } },
        select: { type: "array", items: { type: "string", enum: aggregates } },
        order_by: {
          type: "object",
          additionalProperties: false,
          properties: {
            col: { type: "string", enum: [...aggregates, "date", "amount_cents", "category", "subcategory", "source"] },
            dir: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["col"],
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
};

const INCOME_TOOL: llm.Tool = {
  type: "function",
  function: {
    name: "query_incomes",
    description: "Read-only income search and aggregation. Income origin such as employer, client, refund issuer, or bonus source is usually in source. note_like and source_like are literal case-insensitive substring searches. If both are supplied they must both match. Use separate calls to search either field. order_by.col must be a selected aggregate, active grouping key, or raw-row field. Raw rows are capped at 200.",
    parameters: {
      type: "object",
      properties: {
        where: commonWhere,
        group_by: { type: "array", items: { type: "string", enum: ["source", "date", "month", "weekday"] } },
        select: { type: "array", items: { type: "string", enum: aggregates } },
        order_by: {
          type: "object",
          additionalProperties: false,
          properties: {
            col: { type: "string", enum: [...aggregates, "date", "amount_cents", "source"] },
            dir: { type: "string", enum: ["asc", "desc"] },
          },
          required: ["col"],
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
};

const CASHFLOW_TOOL: llm.Tool = {
  type: "function",
  function: {
    name: "query_cashflow",
    description: "Read-only deterministic income, expenses, and net calculation. With no dates it returns all recorded income minus all recorded expenses, which is the user's balance. Use date_to without date_from for balance through a date. Use group_by='month' for monthly cash flow. Never calculate income minus expenses yourself.",
    parameters: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "Inclusive ISO date YYYY-MM-DD" },
        date_to: { type: "string", description: "Inclusive ISO date YYYY-MM-DD" },
        group_by: { type: "string", enum: ["month"] },
      },
      additionalProperties: false,
    },
  },
};

const MONEY_KEYS = new Set(["sum", "avg", "min", "max", "amount_cents"]);

const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;

const formatRow = (row: Record<string, unknown>, currency: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === "number" && (MONEY_KEYS.has(key) || key.endsWith("_cents")) ? money(value, currency) : value,
  ]));

export const ask = async (database: D1Database, hfToken: string, user: ZonedUser, question: string): Promise<string> => {
  if (!question) return [
    "Usage: /ask <question>",
    "Examples:",
    "  /ask compare income and expenses by month this year",
    "  /ask how much did I spend on groceries in the last 3 months?",
    "  /ask find entries mentioning K-Market",
  ].join("\n");
  const today = localDate(user.timezone);
  const taxonomy = Object.entries(TAXONOMY).map(([category, subs]) => `  ${category}: ${subs.join(", ")}`).join("\n");
  const system = `Today is ${today}. The user's timezone is ${user.timezone}. The user's currency is ${user.currency}.

Answer the user's finance question with the read-only tools, then give a short plain-text answer. No markdown, asterisks, preamble, or unsupported claims.

Work iteratively when useful. A broad query may reveal the filter needed for a second query. If a text search is empty, try a shorter meaningful substring or the other text field before concluding there is no match. Use separate calls to search note OR source because putting both filters in one call means both must match. Multiple tool calls in one round are allowed.

Use query_expenses for spending, categories, merchants, items, and payment sources. Merchant text is usually in note; payment method or account is usually in source. Use query_incomes for salary, bonuses, freelance work, reimbursements, refunds, and other incoming money. Income origin is usually in source. Use query_cashflow for income versus expenses, net, or balance. Never add, subtract, average, count, rank, or compare monetary values yourself when a tool can calculate it.

For query_expenses and query_incomes:
- One total: select=['sum'] with no group_by.
- Breakdown: group_by plus select=['sum'].
- Ranking or extremes: use order_by and limit.
- Raw matching entries: omit both select and group_by.
- Copy formatted amounts from tool results exactly.

Time phrases: "this month" = current month start through today; "last month" = previous calendar month; "this year" = January 1 through today; "last year" = previous January 1 through December 31; a bare month name means the most recent past occurrence.

Expense categories and subcategories, which must be passed exactly:
${taxonomy}`;

  const handler = async (name: string, args: unknown) => {
    const result = name === "query_expenses"
      ? await runExpenseQuery(database, user.id, args)
      : name === "query_incomes"
        ? await runIncomeQuery(database, user.id, args)
        : name === "query_cashflow"
          ? await runCashflowQuery(database, user.id, args)
          : { rows: [{ error: `unknown tool ${name}` }] };
    return { rows: result.rows.map(row => formatRow(row as Record<string, unknown>, user.currency)) };
  };

  return llm.chatWithTools(
    hfToken,
    [{ role: "system", content: system }, { role: "user", content: question }],
    [EXPENSE_TOOL, INCOME_TOOL, CASHFLOW_TOOL],
    handler,
    8,
  );
};
