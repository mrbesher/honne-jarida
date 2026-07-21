import assert from "node:assert/strict";
import test from "node:test";
import { chatWithTools, extract } from "../src/llm.ts";

const completion = (transactions: unknown[]) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ transactions }) } }],
}), { status: 200, headers: { "Content-Type": "application/json" } });

test("extracts mixed income and expense transactions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => completion([
    {
      kind: "income",
      date: "2026-07-20",
      amount: 2500,
      currency: "EUR",
      source: "JYU Salary",
      note: "July salary",
    },
    {
      kind: "expense",
      date: "2026-07-20",
      amount: 4.5,
      currency: "EUR",
      category: "Eating Out",
      subcategory: "Cafe",
      source: "Cash",
      note: "Coffee",
    },
  ]);
  try {
    assert.deepEqual(await extract("token", null, "salary and coffee", "2026-07-21", "EUR"), [
      {
        kind: "income",
        date: "2026-07-20",
        amount_cents: 250000,
        source: "JYU Salary",
        note: "July salary",
      },
      {
        kind: "expense",
        date: "2026-07-20",
        amount_cents: 450,
        category: "Eating Out",
        subcategory: "Cafe",
        source: "Cash",
        note: "Coffee",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("income mode rejects expense results", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => completion([
    {
      kind: "expense",
      date: "2026-07-20",
      amount: 10,
      currency: "EUR",
      category: "Eating Out",
      subcategory: "Cafe",
      source: null,
      note: "Lunch",
    },
    {
      kind: "income",
      date: "2026-07-20",
      amount: 25,
      currency: "EUR",
      source: "Refund from Store",
      note: "",
    },
  ]);
  try {
    assert.deepEqual(await extract("token", null, "refund", "2026-07-21", "EUR", "income"), [{
      kind: "income",
      date: "2026-07-20",
      amount_cents: 2500,
      source: "Refund from Store",
      note: null,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("converts foreign income and preserves the original amount", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes("huggingface.co")) return completion([{
      kind: "income",
      date: "2026-07-20",
      amount: 100,
      currency: "USD",
      source: "Freelance",
      note: "Project payment",
    }]);
    return new Response(JSON.stringify({ rates: { EUR: 0.85 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    assert.deepEqual(await extract("token", null, "100 USD freelance payment", "2026-07-21", "EUR"), [{
      kind: "income",
      date: "2026-07-20",
      amount_cents: 8500,
      source: "Freelance",
      note: "Project payment (100.00 USD)",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tool chat gets eight query rounds plus a final synthesis", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    calls++;
    const message = calls <= 8
      ? { content: null, tool_calls: [{ id: `call-${calls}`, type: "function", function: { name: "query", arguments: "{}" } }] }
      : { content: "Final answer from all results." };
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    let handled = 0;
    const answer = await chatWithTools(
      "token",
      [{ role: "user", content: "question" }],
      [{ type: "function", function: { name: "query", description: "test", parameters: { type: "object" } } }],
      async () => ({ value: ++handled }),
      8,
    );
    assert.equal(answer, "Final answer from all results.");
    assert.equal(handled, 8);
    assert.equal(calls, 9);
    assert.equal("tools" in bodies.at(-1)!, false);
    assert.equal("tool_choice" in bodies.at(-1)!, false);
    const finalMessages = bodies.at(-1)!.messages as { role: string }[];
    assert.equal(finalMessages.filter(message => message.role === "tool").length, 8);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
