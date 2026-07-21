import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ask } from "../src/ask.ts";

test("ask exposes all finance tools and returns formatted cashflow results for synthesis", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE expenses (id INTEGER PRIMARY KEY, user_id INTEGER, date TEXT, amount_cents INTEGER, category TEXT, subcategory TEXT, source TEXT, note TEXT);
    CREATE TABLE incomes (id INTEGER PRIMARY KEY, user_id INTEGER, date TEXT, amount_cents INTEGER, source TEXT, note TEXT);
    INSERT INTO incomes VALUES (1, 1, '2026-07-01', 200000, 'Salary', NULL);
    INSERT INTO expenses VALUES (1, 1, '2026-07-02', 50000, 'Essentials', 'Rent/Mortgage', NULL, NULL);
  `);
  const database = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({ all: () => ({ results: sqlite.prepare(sql).all(...params) }) }),
    }),
  } as unknown as D1Database;
  const bodies: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const message = bodies.length === 1
      ? { content: null, tool_calls: [{ id: "cash", type: "function", function: { name: "query_cashflow", arguments: "{}" } }] }
      : { content: "Your balance is 1500.00 EUR." };
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const answer = await ask(database, "token", {
      id: 1,
      status: "approved",
      currency: "EUR",
      timezone: "Europe/Helsinki",
      first_name: null,
      last_name: null,
      username: null,
      requested_at: "2026-07-01 00:00:00",
    }, "What is my balance?");
    assert.equal(answer, "Your balance is 1500.00 EUR.");
    const tools = bodies[0].tools as { function: { name: string } }[];
    assert.deepEqual(tools.map(tool => tool.function.name), ["query_expenses", "query_incomes", "query_cashflow"]);
    const secondMessages = bodies[1].messages as { role: string; content: string }[];
    assert.match(secondMessages.find(message => message.role === "tool")!.content, /"net_cents":"1500\.00 EUR"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
