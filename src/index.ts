import * as db from "./db.ts";
import * as tg from "./telegram.ts";
import * as llm from "./llm.ts";
import { ask as financeAsk } from "./ask.ts";
import { cashOverview, chartView, validMonth } from "./reports.ts";
import { TAXONOMY, CATEGORIES, canonicalCategory, canonicalSubcategory, type Category } from "./taxonomy.ts";
import { canonicalTimeZone, isIsoDate, localDate } from "./time.ts";

interface Env {
  DB: D1Database;
  BACKUP: R2Bucket;
  TG_TOKEN: string;
  TG_SECRET: string;
  HF_TOKEN: string;
}

type From = { id: number; first_name?: string; last_name?: string; username?: string };
type Message = { message_id: number; from: From; chat: { id: number }; text?: string; caption?: string; photo?: { file_id: string }[]; document?: { file_id: string; mime_type?: string } };
type CallbackQuery = { id: string; from: From; message: Message; data: string };
type Update = { message?: Message; callback_query?: CallbackQuery };
type ZonedUser = db.User & { timezone: string };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_SECRET) return new Response("ok");
      const update = await req.json() as Update;
      ctx.waitUntil(handle(update, env).catch(console.error));
    } catch (e) {
      console.error(e);
    }
    return new Response("ok");
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await sweepAll(env);
    await backup(env);
    await digest(env);
  },
};

const handle = async (u: Update, env: Env) => {
  try {
    await sweepAll(env);
    if (u.message) await onMessage(u.message, env);
    else if (u.callback_query) await onCallback(u.callback_query, env);
  } catch (e) {
    console.error(e);
    const chatId = u.message?.chat.id ?? u.callback_query?.message.chat.id;
    if (chatId) await tg.sendMessage(env.TG_TOKEN, chatId, "Something broke. Try again.");
  }
};

const sweepAll = async (env: Env) => {
  const { results } = await db.sweep(env.DB);
  for (const { chat_id, message_id } of results) {
    await tg.deleteMessage(env.TG_TOKEN, chat_id, message_id);
  }
  await db.sweepPendingUsers(env.DB);
};

const onMessage = async (m: Message, env: Env) => {
  const cmd = m.text?.trim().split(/\s+/)[0];
  if (cmd === "/register") return register(m, env);
  const user = await db.getUser(env.DB, m.from.id);
  if (!user || user.status === "pending") return;
  if (cmd === "/timezone") return setTimezone(m, env, user);
  if (!user.timezone) {
    await tg.sendMessage(env.TG_TOKEN, m.chat.id, "Set your timezone first: /timezone <Area/City>\nExample: /timezone Europe/Paris");
    return;
  }
  const zonedUser = { ...user, timezone: user.timezone };
  if (m.text?.startsWith("/")) return command(m, env, zonedUser);
  return onReceipt(m, env, zonedUser);
};

const onCallback = async (c: CallbackQuery, env: Env) => {
  const user = await db.getUser(env.DB, c.from.id);
  if (!user || user.status === "pending") {
    await tg.answerCallbackQuery(env.TG_TOKEN, c.id);
    return;
  }
  const parts = c.data.split(":");
  const action = parts[0];
  const id = parseInt(parts[1]);
  const chat_id = c.message.chat.id;
  const message_id = c.message.message_id;
  if (!await db.activePrompt(env.DB, chat_id, message_id)) {
    await tg.answerCallbackQuery(env.TG_TOKEN, c.id, "This prompt has expired.");
    return;
  }
  switch (action) {
    case "ok":
      await db.dropPrompt(env.DB, chat_id, message_id);
      await tg.deleteMessage(env.TG_TOKEN, chat_id, message_id);
      break;
    case "del":
      await db.remove(env.DB, user.id, id);
      await db.dropPrompt(env.DB, chat_id, message_id);
      await tg.deleteMessage(env.TG_TOKEN, chat_id, message_id);
      break;
    case "idel":
      await db.removeIncome(env.DB, user.id, id);
      await db.dropPrompt(env.DB, chat_id, message_id);
      await tg.deleteMessage(env.TG_TOKEN, chat_id, message_id);
      break;
    case "cat":
      await tg.editMessageText(env.TG_TOKEN, chat_id, message_id, c.message.text!, categoryKeyboard(id));
      break;
    case "setcat": {
      const cat = canonicalCategory(parts.slice(2).join(":"));
      if (!cat) break;
      await tg.editMessageText(env.TG_TOKEN, chat_id, message_id, `${c.message.text}\n\nPicked ${cat}. Now choose a subcategory:`, subcategoryKeyboard(id, cat));
      break;
    }
    case "setsub": {
      const cat = canonicalCategory(parts[2]);
      const sub = cat ? canonicalSubcategory(cat, parts.slice(3).join(":")) : null;
      if (!cat || !sub) break;
      await db.setCategoryAndSub(env.DB, user.id, id, cat, sub);
      const t = await db.get(env.DB, user.id, id);
      if (t) await tg.editMessageText(env.TG_TOKEN, chat_id, message_id, formatExpense(id, t, user.currency), expenseKeyboard(id));
      break;
    }
  }
  await tg.answerCallbackQuery(env.TG_TOKEN, c.id);
};

const register = async (m: Message, env: Env) => {
  const reply = (txt: string) => tg.sendMessage(env.TG_TOKEN, m.chat.id, txt);
  const existing = await db.getUser(env.DB, m.from.id);
  if (existing && existing.status !== "pending") {
    return reply(existing.timezone ? "Already registered." : "Already registered. Set your timezone: /timezone <Area/City>");
  }
  if (existing) return reply(`Your ID: ${existing.id}. Contact the bot manager to approve.`);
  const [, currencyArg, timezoneArg, ...extra] = m.text?.trim().split(/\s+/) ?? [];
  const ccy = currencyArg?.toUpperCase();
  const timezone = timezoneArg ? canonicalTimeZone(timezoneArg) : null;
  if (!ccy || !/^[A-Z]{3}$/.test(ccy) || !timezone || extra.length) {
    return reply("Usage: /register <currency> <timezone>\nExample: /register EUR Europe/Helsinki");
  }
  await db.insertPendingUser(env.DB, {
    id: m.from.id,
    currency: ccy,
    timezone,
    first_name: m.from.first_name ?? null,
    last_name: m.from.last_name ?? null,
    username: m.from.username ?? null,
  });
  return reply(`Your ID: ${m.from.id}. Contact the bot manager to approve.`);
};

const setTimezone = async (m: Message, env: Env, user: db.User) => {
  const value = m.text?.trim().split(/\s+/)[1] ?? "";
  const timezone = canonicalTimeZone(value);
  if (!timezone || m.text?.trim().split(/\s+/).length !== 2) {
    return tg.sendMessage(env.TG_TOKEN, m.chat.id, "Usage: /timezone <Area/City>\nExample: /timezone Europe/Paris");
  }
  await db.setTimezone(env.DB, user.id, timezone);
  return tg.sendMessage(env.TG_TOKEN, m.chat.id, `Timezone set to ${timezone}.`);
};

const onReceipt = async (m: Message, env: Env, user: ZonedUser) => {
  if (m.document?.mime_type && !m.document.mime_type.startsWith("image/")) {
    await tg.sendMessage(env.TG_TOKEN, m.chat.id, `Can't read ${m.document.mime_type ?? "that file type"}. Send a photo or screenshot instead.`);
    return;
  }
  const fileId = m.photo?.at(-1)?.file_id ?? m.document?.file_id;
  const imageUrl = fileId ? await tg.fileDataUrl(env.TG_TOKEN, fileId) : null;
  const text = m.text ?? m.caption ?? "";
  if (!imageUrl && !text) return;
  const today = localDate(user.timezone);
  const parsed = await llm.extract(env.HF_TOKEN, imageUrl, text, today, user.currency);
  if (!parsed.length) {
    await tg.sendMessage(env.TG_TOKEN, m.chat.id, "Couldn't read that. Try again or use /add.");
    return;
  }
  await saveExtracted(m.chat.id, env, user, parsed);
};

const saveExtracted = async (chatId: number, env: Env, user: db.User, parsed: llm.Extracted[]) => {
  for (const p of parsed) {
    if (p.kind === "expense") {
      const ins = await db.insertExpense(env.DB, user.id, p);
      const id = ins!.id;
      const duplicate = await db.duplicateExpense(env.DB, user.id, id, p);
      const warning = duplicate ? `Possible duplicate of #${duplicate.id}. Both are saved.\n\n` : "";
      const reply = await tg.sendMessage(env.TG_TOKEN, chatId, warning + formatExpense(id, p, user.currency), expenseKeyboard(id, !!duplicate));
      await db.trackPrompt(env.DB, chatId, reply.message_id);
      continue;
    }
    const ins = await db.insertIncome(env.DB, user.id, p);
    const id = ins!.id;
    const duplicate = await db.duplicateIncome(env.DB, user.id, id, p);
    const warning = duplicate ? `Possible duplicate of income #${duplicate.id}. Both are saved.\n\n` : "";
    const reply = await tg.sendMessage(env.TG_TOKEN, chatId, warning + formatIncome(id, p, user.currency), incomeKeyboard(id, !!duplicate));
    await db.trackPrompt(env.DB, chatId, reply.message_id);
  }
};

const command = async (m: Message, env: Env, user: ZonedUser) => {
  const [cmd, ...args] = m.text!.trim().split(/\s+/);
  const reply = (txt: string) => tg.sendMessage(env.TG_TOKEN, m.chat.id, txt);
  if (cmd === "/approve") {
    if (user.status !== "admin") return;
    return approve(env, m.chat.id, args);
  }
  switch (cmd) {
    case "/cash": {
      if (args.length > 1 || (args[0] && !validMonth(args[0]))) return reply("Usage: /cash [yyyy-mm]");
      return reply(await cashOverview(env.DB, user, args[0]));
    }
    case "/chart": {
      const view = await chartView(env.DB, user, args);
      if ("text" in view) return reply(view.text);
      await tg.sendPhoto(env.TG_TOKEN, m.chat.id, view.url, view.caption);
      return;
    }
    case "/last": {
      const limit = parseInt(args[0] || "10");
      const [ex, inc] = await Promise.all([db.recentExpenses(env.DB, user.id, limit), db.recentIncomes(env.DB, user.id, limit)]);
      const merged = [
        ...ex.results.map(r => ({ kind: "e" as const, r })),
        ...inc.results.map(r => ({ kind: "i" as const, r })),
      ].sort((a, b) => (b.r.date + b.r.id).localeCompare(a.r.date + a.r.id)).slice(0, limit);
      if (!merged.length) return reply("No entries.");
      return reply(merged.map(({ kind, r }) =>
        kind === "e" ? formatExpense(r.id, r as db.Expense, user.currency)
                     : formatIncome(r.id, r as db.Income, user.currency)
      ).join("\n\n"));
    }
    case "/edit": {
      const [idStr, field, ...rest] = args;
      const id = parseInt(idStr);
      const value = rest.join(" ");
      if (!await applyEdit(env.DB, user.id, id, field, value)) {
        if (field === "category" || field === "subcategory") return sendPicker(env, user.id, m.chat.id, id, field);
        return reply(`Editable fields: amount, date, category, subcategory, source, note.`);
      }
      const t = await db.get(env.DB, user.id, id);
      return reply(t ? formatExpense(id, t, user.currency) : `#${id} not found.`);
    }
    case "/add": {
      const amount = Math.round(parseFloat(args[0]) * 100);
      if (!Number.isFinite(amount) || amount <= 0) return reply("Usage: /add <amount> <category> <subcategory> [note]");
      const picked = pickCategoryAndSub(args.slice(1));
      if (!picked) return reply(`Need a valid category and subcategory.\n${categoryList()}`);
      const today = localDate(user.timezone);
      const ins = await db.insertExpense(env.DB, user.id, { date: today, amount_cents: amount, category: picked.category, subcategory: picked.subcategory, source: null, note: picked.note });
      return reply(`+${money(amount, user.currency)} ${picked.category}/${picked.subcategory} (#${ins!.id})`);
    }
    case "/income": {
      const rawAmount = args[0] ?? "";
      const amount = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(rawAmount)
        ? Math.round(Number(rawAmount) * 100)
        : NaN;
      if (!Number.isFinite(amount) || amount <= 0) {
        const today = localDate(user.timezone);
        const parsed = await llm.extract(env.HF_TOKEN, null, args.join(" "), today, user.currency, "income");
        if (!parsed.length) return reply("Couldn't read that income. Try /income <amount> <source> [note].");
        return saveExtracted(m.chat.id, env, user, parsed);
      }
      const source = args[1]?.replace(/_/g, " ") || null;
      const note = args.slice(2).join(" ") || null;
      const today = localDate(user.timezone);
      return saveExtracted(m.chat.id, env, user, [{ kind: "income", date: today, amount_cents: amount, source, note }]);
    }
    case "/undo": {
      const [ex, inc] = await Promise.all([db.recentExpenses(env.DB, user.id, 1), db.recentIncomes(env.DB, user.id, 1)]);
      const last = [
        ex.results[0] ? { kind: "e" as const, r: ex.results[0] } : null,
        inc.results[0] ? { kind: "i" as const, r: inc.results[0] } : null,
      ].filter(Boolean).sort((a, b) => b!.r.created_at.localeCompare(a!.r.created_at))[0];
      if (!last) return reply("Nothing to undo.");
      if (last.kind === "e") await db.remove(env.DB, user.id, last.r.id);
      else await db.removeIncome(env.DB, user.id, last.r.id);
      return reply(`Undone ${last.kind === "e" ? "expense" : "income"} #${last.r.id}.`);
    }
    case "/recurring": return reply(await recurringList(env.DB, user));
    case "/why": return reply(await why(env, user, args[0]));
    case "/ask": return reply(stripMarkdown(await financeAsk(env.DB, env.HF_TOKEN, user, args.join(" "))));
    default:
      return reply(help());
  }
};

const recurringList = async (database: D1Database, user: ZonedUser) => {
  const { results: amounts } = await database.prepare(
    "SELECT amount_cents FROM expenses WHERE user_id=? ORDER BY amount_cents"
  ).bind(user.id).all<{ amount_cents: number }>();
  const floor = amounts.length ? amounts[Math.floor(amounts.length * 0.25)].amount_cents : 0;
  const { results } = await db.recurring(database, user.id, floor, localDate(user.timezone));
  if (!results.length) return "No recurring patterns found.";
  return results.map(r => {
    const desc = r.note ? ` - ${r.note}` : "";
    return `${money(r.avg_cents, user.currency)} every ${Math.round(r.interval_days)}d  ${r.category}/${r.subcategory}${desc}\n  last ${r.last_date}, ${r.n}× in 3mo`;
  }).join("\n\n");
};

const why = async (env: Env, user: ZonedUser, ymArg?: string): Promise<string> => {
  const today = localDate(user.timezone);
  const ym = ymArg ?? today.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(ym)) return "Usage: /why [yyyy-mm]";
  const sum = await db.monthSummary(env.DB, user.id, ym);
  const monthTotal = sum.results.reduce((s, r) => s + r.cents, 0);
  if (!monthTotal) return `${ym}: no expenses.`;
  const big = await db.biggestInMonth(env.DB, user.id, ym, 10);
  const cats = await db.subcatVsAvg(env.DB, user.id, ym, 10, 10);
  const isCurrent = ym === today.slice(0, 7);
  const dim = new Date(Date.UTC(parseInt(ym.slice(0, 4)), parseInt(ym.slice(5, 7)), 0)).getUTCDate();
  const day = isCurrent ? parseInt(today.slice(8, 10)) : dim;
  const partial = isCurrent && day < dim;
  const ccy = user.currency;

  const bigBlock = big.results.map(r => `  ${money(r.amount_cents, ccy)}  ${r.date}  ${r.category}/${r.subcategory}${r.note ? " - " + r.note : ""}`).join("\n");
  const catBlock = cats.results.map(r => {
    const ratio = r.avg_cents > 0 ? `${Math.round(r.current_cents / r.avg_cents * 100)}% of avg` : "first time";
    return `  ${r.category}/${r.subcategory}: ${money(r.current_cents, ccy)} (10mo avg ${money(r.avg_cents, ccy)}, ${ratio})`;
  }).join("\n");

  const system = `You are a personal finance analyst. Analyze the data below and produce two sections.

1. Drivers: cold, data-driven reasons for spikes or top offenders. Cite specific category/transaction. No causation you cannot see in the numbers. 3 bullets max.
2. Recommendations: 2 personalized, specific suggestions to improve. Reference the actual data (e.g., "X and Y together cost Z/mo; consider cancelling one").

Plain text only. No markdown, no asterisks, no headings. Use simple hyphens for bullets. Be terse. No preamble. No filler.`;

  const userMsg = `Month: ${ym}${partial ? ` (partial: day ${day} of ${dim})` : ""}
Total expenses: ${money(monthTotal, ccy)}

Top single expenses this month:
${bigBlock}

Top categories vs 10-month average:
${catBlock}`;

  return stripMarkdown(await llm.chat(env.HF_TOKEN, system, userMsg));
};

const approve = async (env: Env, chatId: number, args: string[]) => {
  const reply = (txt: string) => tg.sendMessage(env.TG_TOKEN, chatId, txt);
  if (args.length === 0) {
    const { results } = await db.listPending(env.DB);
    if (!results.length) return reply("No pending requests.");
    return reply(results.map(formatPending).join("\n"));
  }
  const id = parseInt(args[0]);
  if (!Number.isFinite(id)) return reply("Bad id.");
  const result = await db.approveUser(env.DB, id);
  if (!result.meta.changes) return reply(`#${id} not pending.`);
  const approved = await db.getUser(env.DB, id);
  await tg.sendMessage(
    env.TG_TOKEN,
    id,
    approved?.timezone ? "You're approved. You can now use the bot." : "You're approved. Set your timezone first: /timezone <Area/City>",
  );
  return reply(`Approved #${id}.`);
};

const formatPending = (u: db.User) => {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "?";
  const handle = u.username ? ` @${u.username}` : "";
  return `${u.id}  ${u.currency}  ${u.timezone ?? "timezone missing"}  ${name}${handle}  ${u.requested_at.slice(0, 10)}`;
};

const help = () => [
  "/cash [yyyy-mm]  balance and monthly overview",
  "/chart [spending]  cash trajectory or spending mix",
  "/recurring  detected recurring charges",
  "/why [yyyy-mm]  drivers and recommendations for the month",
  "/ask <question>  search and analyze income and expenses",
  "/last [n]  recent entries (default 10)",
  "/edit <id> <field> <value>  update a field",
  "  fields: amount, date, category, subcategory, source, note",
  "/add <amount> <category> <subcategory> [note]  manual expense",
  "/income <amount> <source> [note]  log income",
  "/timezone <Area/City>  set your local timezone",
  "/undo  delete last entry",
  "",
  "Or just send a receipt photo, screenshot, or text.",
].join("\n");

const categoryList = () =>
  Object.entries(TAXONOMY).map(([c, subs]) => `  ${c}: ${subs.join(", ")}`).join("\n");

const pickCategoryAndSub = (args: string[]): { category: Category; subcategory: string; note: string } | null => {
  const flat = args.join(" ").replace(/_/g, " ").trim();
  if (!flat) return null;
  const tokens = flat.split(/\s+/);
  for (let i = tokens.length; i >= 1; i--) {
    const cat = canonicalCategory(tokens.slice(0, i).join(" "));
    if (!cat) continue;
    const after = tokens.slice(i);
    for (let j = after.length; j >= 1; j--) {
      const sub = canonicalSubcategory(cat, after.slice(0, j).join(" "));
      if (sub) return { category: cat, subcategory: sub, note: after.slice(j).join(" ") };
    }
  }
  return null;
};

const sendPicker = async (env: Env, userId: number, chat_id: number, id: number, field: "category" | "subcategory") => {
  if (field === "category") {
    const reply = await tg.sendMessage(env.TG_TOKEN, chat_id, `Pick a category for #${id}:`, categoryKeyboard(id));
    await db.trackPrompt(env.DB, chat_id, reply.message_id);
    return;
  }
  const t = await db.get(env.DB, userId, id);
  if (!t) { await tg.sendMessage(env.TG_TOKEN, chat_id, `#${id} not found.`); return; }
  const reply = await tg.sendMessage(env.TG_TOKEN, chat_id, `Pick a subcategory for #${id}:`, subcategoryKeyboard(id, t.category));
  await db.trackPrompt(env.DB, chat_id, reply.message_id);
};

const applyEdit = async (database: D1Database, userId: number, id: number, field: string, value: string): Promise<boolean> => {
  switch (field) {
    case "amount": {
      const cents = Math.round(parseFloat(value) * 100);
      if (!Number.isFinite(cents) || cents <= 0) return false;
      await db.update(database, userId, id, "amount_cents", cents);
      return true;
    }
    case "date":
      if (!isIsoDate(value)) return false;
      await db.update(database, userId, id, "date", value);
      return true;
    case "category":
    case "subcategory":
      return false;
    case "source":
    case "note":
      await db.update(database, userId, id, field, value || null);
      return true;
    default:
      return false;
  }
};

const expenseKeyboard = (id: number, duplicate = false) => ({
  inline_keyboard: [[
    { text: duplicate ? "Keep both" : "OK", callback_data: `ok:${id}` },
    { text: "Edit category", callback_data: `cat:${id}` },
    { text: duplicate ? "Delete new" : "Delete", callback_data: `del:${id}` },
  ]],
});

const incomeKeyboard = (id: number, duplicate = false) => ({
  inline_keyboard: [[
    { text: duplicate ? "Keep both" : "OK", callback_data: `ok:${id}` },
    { text: duplicate ? "Delete new" : "Delete", callback_data: `idel:${id}` },
  ]],
});

const categoryKeyboard = (id: number) => ({
  inline_keyboard: CATEGORIES.map(c => [{ text: c, callback_data: `setcat:${id}:${c}` }]),
});

const subcategoryKeyboard = (id: number, cat: Category) => ({
  inline_keyboard: TAXONOMY[cat].map(s => [{ text: s, callback_data: `setsub:${id}:${cat}:${s}` }]),
});

const formatExpense = (id: number, e: Pick<db.Expense, "date" | "amount_cents" | "category" | "subcategory" | "source" | "note">, ccy: string) => {
  const src = e.source ? `  ${e.source}` : "";
  const note = e.note ? `\n${e.note}` : "";
  return `#${id}  ${money(e.amount_cents, ccy)}  ${e.date}\n${e.category}/${e.subcategory}${src}${note}`;
};

const formatIncome = (id: number, i: Pick<db.Income, "date" | "amount_cents" | "source" | "note">, ccy: string) => {
  const note = i.note ? `\n${i.note}` : "";
  return `#${id} (income)  +${money(i.amount_cents, ccy)}  ${i.date}\nfrom ${i.source ?? "?"}${note}`;
};

const money = (cents: number, ccy: string) => `${(cents / 100).toFixed(2)} ${ccy}`;

const stripMarkdown = (s: string) => s.replace(/\*\*([^*]+?)\*\*/g, "$1").replace(/\*\*/g, "").replace(/__([^_]+?)__/g, "$1");

const backup = async (env: Env) => {
  const [{ results: ex }, { results: inc }] = await Promise.all([db.allExpenses(env.DB), db.allIncomes(env.DB)]);
  await env.BACKUP.put(`backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ expenses: ex, incomes: inc }));
};

const digest = async (env: Env) => {
  const { results: users } = await db.activeUsers(env.DB);
  for (const u of users) {
    if (!u.timezone) {
      await tg.sendMessage(env.TG_TOKEN, u.id, "Set your timezone first: /timezone <Area/City>");
      continue;
    }
    const today = localDate(u.timezone);
    const ym = today.slice(0, 7);
    const cash = await db.cash(env.DB, u.id);
    const burn7 = await db.burn(env.DB, u.id, 7, today);
    const avg7 = (await db.burn(env.DB, u.id, 28, today)) / 4;
    const summary = await db.monthSummary(env.DB, u.id, ym);
    const lines = [
      "Weekly digest",
      `Balance ${money(cash, u.currency)}, last 7 days ${money(burn7, u.currency)} (4w avg ${money(avg7, u.currency)})`,
      burn7 > avg7 * 1.5 && burn7 > 5000 ? `Spike: ${((burn7 / avg7 - 1) * 100).toFixed(0)}% above 4w average.` : "",
      "",
      `${ym} so far:`,
      ...summary.results.slice(0, 5).map(r => `  ${r.category}: ${money(r.cents, u.currency)} × ${r.n}`),
    ].filter(Boolean);
    await tg.sendMessage(env.TG_TOKEN, u.id, lines.join("\n"));
  }
};
