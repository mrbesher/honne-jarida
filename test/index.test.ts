import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

type State = {
  incomes: { id: number; user_id: number; date: string; amount_cents: number; source: string | null; note: string | null }[];
  prompts: { chat_id: number; message_id: number }[];
  user?: {
    id: number;
    status: "pending" | "approved" | "admin";
    currency: string;
    timezone: string | null;
    first_name: string | null;
    last_name: string | null;
    username: string | null;
    requested_at: string;
  } | null;
};

const fakeDatabase = (state: State) => ({
  prepare: (sql: string) => {
    const statement = (params: unknown[] = []) => ({
      bind: (...bound: unknown[]) => statement(bound),
      first: () => {
        if (sql.startsWith("SELECT * FROM users")) return state.user === undefined ? {
          id: 1,
          status: "approved",
          currency: "EUR",
          timezone: "Europe/Helsinki",
          first_name: "Test",
          last_name: null,
          username: null,
          requested_at: "2026-07-01 00:00:00",
        } : state.user;
        if (sql.startsWith("INSERT INTO incomes")) {
          const id = state.incomes.length + 1;
          state.incomes.push({
            id,
            user_id: params[0] as number,
            date: params[1] as string,
            amount_cents: params[2] as number,
            source: params[3] as string | null,
            note: params[4] as string | null,
          });
          return { id };
        }
        if (sql.includes("SELECT id FROM incomes")) return null;
        if (sql.includes("SELECT 1 AS active FROM pending_prompts")) {
          return state.prompts.some(p => p.chat_id === params[0] && p.message_id === params[1]) ? { active: 1 } : null;
        }
        throw new Error(`unexpected first: ${sql}`);
      },
      run: () => {
        if (sql.startsWith("DELETE FROM users")) return { meta: { changes: 0 } };
        if (sql.startsWith("INSERT INTO users")) {
          state.user = {
            id: params[0] as number,
            status: "pending",
            currency: params[1] as string,
            timezone: params[2] as string,
            first_name: params[3] as string | null,
            last_name: params[4] as string | null,
            username: params[5] as string | null,
            requested_at: "2026-07-21 00:00:00",
          };
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE users SET timezone")) {
          const allowed = state.user?.status === "approved" || state.user?.status === "admin";
          if (allowed && state.user) state.user.timezone = params[0] as string;
          return { meta: { changes: allowed ? 1 : 0 } };
        }
        if (sql.startsWith("INSERT INTO pending_prompts")) {
          state.prompts.push({ chat_id: params[0] as number, message_id: params[1] as number });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM incomes")) {
          const index = state.incomes.findIndex(i => i.id === params[0] && i.user_id === params[1]);
          if (index >= 0) state.incomes.splice(index, 1);
          return { meta: { changes: index >= 0 ? 1 : 0 } };
        }
        if (sql.startsWith("DELETE FROM pending_prompts")) {
          const index = state.prompts.findIndex(p => p.chat_id === params[0] && p.message_id === params[1]);
          if (index >= 0) state.prompts.splice(index, 1);
          return { meta: { changes: index >= 0 ? 1 : 0 } };
        }
        throw new Error(`unexpected run: ${sql}`);
      },
      all: () => {
        if (sql.startsWith("DELETE FROM pending_prompts")) return { results: [] };
        throw new Error(`unexpected all: ${sql}`);
      },
    });
    return statement();
  },
}) as unknown as D1Database;

const runUpdate = async (update: object, database: D1Database) => {
  const pending: Promise<unknown>[] = [];
  const env = {
    DB: database,
    BACKUP: {},
    TG_TOKEN: "telegram-token",
    TG_SECRET: "secret",
    HF_TOKEN: "hf-token",
  };
  const ctx = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
  await worker.fetch(new Request("https://worker.test", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify(update),
  }), env as never, ctx as never);
  await Promise.all(pending);
};

const incomeCompletion = () => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ transactions: [{
    kind: "income",
    date: "2026-07-20",
    amount: 2500,
    currency: "EUR",
    source: "JYU Salary",
    note: "July salary",
  }] }) } }],
}), { status: 200, headers: { "Content-Type": "application/json" } });

test("ordinary text auto-classifies income and supports passive deletion", async () => {
  const state: State = { incomes: [], prompts: [] };
  const telegramBodies: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("huggingface.co")) return incomeCompletion();
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    telegramBodies.push(body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: 1 } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await runUpdate({ message: { message_id: 1, from: { id: 1 }, chat: { id: 1 }, text: "JYU paid my salary" } }, fakeDatabase(state));
    assert.equal(state.incomes.length, 1);
    assert.deepEqual(state.prompts, [{ chat_id: 1, message_id: 99 }]);
    assert.deepEqual((telegramBodies[0].reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0].map(b => b.callback_data), ["ok:1", "idel:1"]);

    await runUpdate({ callback_query: {
      id: "callback",
      from: { id: 1 },
      data: "idel:1",
      message: { message_id: 99, from: { id: 1 }, chat: { id: 1 }, text: "income" },
    } }, fakeDatabase(state));
    assert.equal(state.incomes.length, 0);
    assert.deepEqual(state.prompts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an expired income prompt cannot delete the saved row", async () => {
  const state: State = {
    incomes: [{ id: 1, user_id: 1, date: "2026-07-20", amount_cents: 250000, source: "JYU Salary", note: null }],
    prompts: [],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  try {
    await runUpdate({ callback_query: {
      id: "expired-callback",
      from: { id: 1 },
      data: "idel:1",
      message: { message_id: 99, from: { id: 1 }, chat: { id: 1 }, text: "income" },
    } }, fakeDatabase(state));
    assert.equal(state.incomes.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid numeric income uses the LLM while valid numeric income stays deterministic", async () => {
  const state: State = { incomes: [], prompts: [] };
  let llmCalls = 0;
  let messageId = 10;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    if (String(input).includes("huggingface.co")) {
      llmCalls++;
      return incomeCompletion();
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: messageId++, chat: { id: 1 } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const database = fakeDatabase(state);
    await runUpdate({ message: { message_id: 1, from: { id: 1 }, chat: { id: 1 }, text: "/income salary from JYU" } }, database);
    await runUpdate({ message: { message_id: 2, from: { id: 1 }, chat: { id: 1 }, text: "/income 50 S_Market bonus" } }, database);
    await runUpdate({ message: { message_id: 3, from: { id: 1 }, chat: { id: 1 }, text: "/income 50abc JYU" } }, database);
    assert.equal(llmCalls, 2);
    assert.equal(state.incomes.length, 3);
    assert.equal(state.incomes[1].amount_cents, 5000);
    assert.equal(state.incomes[1].source, "S Market");
    assert.equal(state.prompts.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("capture defaults use the Helsinki calendar date", async () => {
  const state: State = { incomes: [], prompts: [] };
  const NativeDate = globalThis.Date;
  class FixedDate extends NativeDate {
    constructor(value?: string | number) {
      super(value ?? "2026-12-31T22:30:00Z");
    }
    static now() { return NativeDate.parse("2026-12-31T22:30:00Z"); }
  }
  const originalFetch = globalThis.fetch;
  globalThis.Date = FixedDate as DateConstructor;
  let prompt = "";
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("huggingface.co")) {
      prompt = String(init?.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ transactions: [{
        kind: "income",
        date: "2027-01-01",
        amount: 25,
        currency: "EUR",
        source: "Refund",
        note: "",
      }] }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 50, chat: { id: 1 } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const db = fakeDatabase(state);
    await runUpdate({ message: { message_id: 1, from: { id: 1 }, chat: { id: 1 }, text: "received a refund" } }, db);
    await runUpdate({ message: { message_id: 2, from: { id: 1 }, chat: { id: 1 }, text: "/income 50 Salary" } }, db);
    assert.match(prompt, /Today is 2027-01-01/);
    assert.deepEqual(state.incomes.map(row => row.date), ["2027-01-01", "2027-01-01"]);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Date = NativeDate;
  }
});

test("registration stores timezone but keeps the user pending", async () => {
  const state: State = { incomes: [], prompts: [], user: null };
  const replies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { text?: string };
    if (body.text) replies.push(body.text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await runUpdate({ message: { message_id: 1, from: { id: 7, first_name: "New" }, chat: { id: 7 }, text: "/register usd America/New_York" } }, fakeDatabase(state));
    assert.equal(state.user?.status, "pending");
    assert.equal(state.user?.currency, "USD");
    assert.equal(state.user?.timezone, "America/New_York");
    assert.match(replies[0], /Contact the bot manager/);

    await runUpdate({ message: { message_id: 2, from: { id: 7 }, chat: { id: 7 }, text: "/timezone Europe/Paris" } }, fakeDatabase(state));
    assert.equal(state.user?.timezone, "America/New_York");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("approved users without timezone are prompted and can set one", async () => {
  const state: State = {
    incomes: [],
    prompts: [],
    user: {
      id: 1,
      status: "approved",
      currency: "EUR",
      timezone: null,
      first_name: "Existing",
      last_name: null,
      username: null,
      requested_at: "2026-07-01 00:00:00",
    },
  };
  const replies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { text?: string };
    if (body.text) replies.push(body.text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const db = fakeDatabase(state);
    await runUpdate({ message: { message_id: 1, from: { id: 1 }, chat: { id: 1 }, text: "/income 50 Salary" } }, db);
    assert.equal(state.incomes.length, 0);
    assert.match(replies[0], /Set your timezone first/);

    await runUpdate({ message: { message_id: 2, from: { id: 1 }, chat: { id: 1 }, text: "/timezone Europe/Paris" } }, db);
    assert.equal(state.user?.timezone, "Europe/Paris");
    assert.match(replies[1], /Timezone set to Europe\/Paris/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("registration rejects invalid timezones", async () => {
  const state: State = { incomes: [], prompts: [], user: null };
  let reply = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    reply = (JSON.parse(String(init?.body)) as { text: string }).text;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await runUpdate({ message: { message_id: 1, from: { id: 9 }, chat: { id: 9 }, text: "/register EUR Mars/Olympus" } }, fakeDatabase(state));
    assert.equal(state.user, null);
    assert.match(reply, /Usage: \/register/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("help never advertises the approval command", async () => {
  const state: State = {
    incomes: [],
    prompts: [],
    user: {
      id: 1,
      status: "admin",
      currency: "EUR",
      timezone: "Europe/Helsinki",
      first_name: "Admin",
      last_name: null,
      username: null,
      requested_at: "2026-07-01 00:00:00",
    },
  };
  let reply = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    reply = (JSON.parse(String(init?.body)) as { text: string }).text;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await runUpdate({ message: { message_id: 1, from: { id: 1 }, chat: { id: 1 }, text: "/help" } }, fakeDatabase(state));
    assert.match(reply, /\/cash/);
    assert.doesNotMatch(reply, /\/approve/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
