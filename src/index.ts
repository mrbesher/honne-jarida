import * as db from "./db";
import * as tg from "./telegram";
import { extract } from "./llm";
import { TAXONOMY, isCategory } from "./taxonomy";

interface Env {
  DB: D1Database;
  BACKUP: R2Bucket;
  TG_TOKEN: string;
  TG_SECRET: string;
  TG_USER_ID: string;
  HF_TOKEN: string;
}

type User = { id: number };
type Message = { message_id: number; from: User; chat: { id: number }; text?: string; caption?: string; photo?: { file_id: string }[]; document?: { file_id: string } };
type CallbackQuery = { id: string; from: User; message: Message; data: string };
type Update = { message?: Message; callback_query?: CallbackQuery };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_SECRET) return new Response("ok");
      const update = await req.json() as Update;
      if (userId(update) !== Number(env.TG_USER_ID)) return new Response("ok");
      ctx.waitUntil(handle(update, env).catch(console.error));
    } catch (e) {
      console.error(e);
    }
    return new Response("ok");
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await sweepAndDelete(env);
    await backup(env);
    await digest(env);
  },
};

const userId = (u: Update) => u.message?.from.id ?? u.callback_query?.from.id ?? 0;

const handle = async (u: Update, env: Env) => {
  try {
    await sweepAndDelete(env);
    if (u.message) await onMessage(u.message, env);
    else if (u.callback_query) await onCallback(u.callback_query, env);
  } catch (e) {
    console.error(e);
    const chatId = u.message?.chat.id ?? u.callback_query?.message.chat.id;
    if (chatId) await tg.sendMessage(env.TG_TOKEN, chatId, "Something broke. Try again.");
  }
};

const sweepAndDelete = async (env: Env) => {
  const { results } = await db.sweep(env.DB);
  for (const { chat_id, message_id } of results) {
    await tg.deleteMessage(env.TG_TOKEN, chat_id, message_id);
  }
};

const onMessage = async (m: Message, env: Env) => {
  if (m.text?.startsWith("/")) return command(m, env);
  await onReceipt(m, env);
};

const onReceipt = async (m: Message, env: Env) => {
  const fileId = m.photo?.at(-1)?.file_id ?? m.document?.file_id;
  const imageUrl = fileId ? await tg.fileDataUrl(env.TG_TOKEN, fileId) : null;
  const text = m.text ?? m.caption ?? "";
  if (!imageUrl && !text) return;
  const today = new Date().toISOString().slice(0, 10);
  const parsed = await extract(env.HF_TOKEN, imageUrl, text, today);
  if (!parsed.length) {
    await tg.sendMessage(env.TG_TOKEN, m.chat.id, "Couldn't read that. Try again or use /add.");
    return;
  }
  for (const p of parsed) {
    const ins = await db.insert(env.DB, "expense", p);
    const id = ins!.id;
    const reply = await tg.sendMessage(env.TG_TOKEN, m.chat.id, formatTxn(id, p), promptKeyboard(id));
    await db.trackPrompt(env.DB, m.chat.id, reply.message_id, id);
  }
};

const onCallback = async (c: CallbackQuery, env: Env) => {
  const [action, idStr, ...rest] = c.data.split(":");
  const id = parseInt(idStr);
  const chat_id = c.message.chat.id;
  const message_id = c.message.message_id;
  switch (action) {
    case "ok":
      await db.dropPrompt(env.DB, chat_id, message_id);
      await tg.editMessageText(env.TG_TOKEN, chat_id, message_id, c.message.text!);
      break;
    case "del":
      await db.remove(env.DB, id);
      await db.dropPrompt(env.DB, chat_id, message_id);
      await tg.deleteMessage(env.TG_TOKEN, chat_id, message_id);
      break;
    case "cat":
      await tg.editMessageText(env.TG_TOKEN, chat_id, message_id, c.message.text!, categoryKeyboard(id));
      break;
    case "set": {
      const cat = rest.join(":");
      if (!isCategory(cat)) break;
      await db.update(env.DB, id, "category", cat);
      await db.update(env.DB, id, "subcategory", null);
      const t = await db.get(env.DB, id);
      if (t) await tg.editMessageText(env.TG_TOKEN, chat_id, message_id, formatTxn(id, t), promptKeyboard(id));
      break;
    }
  }
  await tg.answerCallbackQuery(env.TG_TOKEN, c.id);
};

const command = async (m: Message, env: Env) => {
  const [cmd, ...args] = m.text!.trim().split(/\s+/);
  const reply = (txt: string) => tg.sendMessage(env.TG_TOKEN, m.chat.id, txt);
  switch (cmd) {
    case "/cash": {
      const c = await db.cash(env.DB);
      const b = await db.expectedMonthlyBurn(env.DB);
      const months = b > 0 ? c / b : Infinity;
      const ym = new Date().toISOString().slice(0, 7);
      const sum = await db.monthSummary(env.DB, ym);
      return reply([
        `Balance: ${money(c)}`,
        `Burn: ${money(b)}/mo`,
        `Runway: ${months === Infinity ? "infinite" : months.toFixed(1) + " months"}`,
        "",
        `${ym} so far:`,
        ...sum.results.slice(0, 10).map(r => `  ${r.category}: ${money(r.cents)} (${r.n})`),
      ].join("\n"));
    }
    case "/sum": {
      const ym = args[0] ?? new Date().toISOString().slice(0, 7);
      const sum = await db.monthSummary(env.DB, ym);
      if (!sum.results.length) return reply(`${ym}: no entries.`);
      const total = sum.results.reduce((s, r) => s + r.cents, 0);
      const n = sum.results.reduce((s, r) => s + r.n, 0);
      return reply([
        `${ym}`,
        `Total: ${money(total)} over ${n} entries`,
        "",
        ...sum.results.map(r => `${r.category}: ${money(r.cents)} (${r.n})`),
      ].join("\n"));
    }
    case "/pie": {
      const ym = args[0] ?? new Date().toISOString().slice(0, 7);
      const sum = await db.monthSummary(env.DB, ym);
      if (!sum.results.length) return reply(`${ym}: no entries.`);
      const config = {
        type: "pie",
        data: {
          labels: sum.results.map(r => r.category),
          datasets: [{ data: sum.results.map(r => +(r.cents / 100).toFixed(2)) }],
        },
        options: { plugins: { title: { display: true, text: `${ym} spending` } } },
      };
      const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}`;
      await tg.sendPhoto(env.TG_TOKEN, m.chat.id, url, `${ym} breakdown`);
      return;
    }
    case "/last": {
      const { results } = await db.recent(env.DB, parseInt(args[0] || "10"));
      if (!results.length) return reply("No entries.");
      const blocks = results.map(r => {
        const sub = r.subcategory ? ` / ${r.subcategory}` : "";
        const note = r.note ? ` - ${r.note}` : "";
        return `#${r.id}  ${r.date}  ${money(r.amount_cents)}\n  ${r.category ?? "?"}${sub}${note}`;
      });
      return reply(blocks.join("\n\n"));
    }
    case "/edit": {
      const [idStr, field, ...rest] = args;
      const id = parseInt(idStr);
      const value = field === "amount_cents" ? Math.round(parseFloat(rest[0]) * 100) : rest.join(" ");
      await db.update(env.DB, id, field, value);
      const t = await db.get(env.DB, id);
      return reply(t ? formatTxn(id, t) : `#${id} not found.`);
    }
    case "/add": {
      const amount = Math.round(parseFloat(args[0]) * 100);
      const category = args[1]?.replace(/_/g, " ") ?? "";
      const note = args.slice(2).join(" ");
      if (!isCategory(category)) return reply(`Bad category. Use one of:\n${categoryList()}`);
      const today = new Date().toISOString().slice(0, 10);
      const ins = await db.insert(env.DB, "expense", { date: today, amount_cents: amount, category, subcategory: null, source: null, note });
      return reply(`+${money(amount)} ${category} (#${ins!.id})`);
    }
    case "/income": {
      const amount = Math.round(parseFloat(args[0]) * 100);
      const source = args[1] ?? null;
      const note = args.slice(2).join(" ");
      const today = new Date().toISOString().slice(0, 10);
      const ins = await db.insert(env.DB, "income", { date: today, amount_cents: amount, category: null, subcategory: null, source, note });
      return reply(`income +${money(amount)} from ${source ?? "?"} (#${ins!.id})`);
    }
    case "/undo": {
      const { results } = await db.recent(env.DB, 1);
      if (!results.length) return reply("Nothing to undo.");
      await db.remove(env.DB, results[0].id);
      return reply(`Undone #${results[0].id}.`);
    }
    default:
      return reply(HELP);
  }
};

const HELP = [
  "/cash  balance, burn, runway, this month",
  "/sum [yyyy-mm]  monthly breakdown",
  "/pie [yyyy-mm]  pie chart of spending",
  "/last [n]  recent entries (default 10)",
  "/edit <id> <field> <value>  update a field",
  "/add <amount> <Category> [note]  manual expense",
  "/income <amount> <source> [note]  log income",
  "/undo  delete last entry",
  "",
  "Or just send a receipt photo, screenshot, or text.",
].join("\n");

const categoryList = () =>
  Object.keys(TAXONOMY).map(c => "  " + c.replace(/ /g, "_")).join("\n");

const promptKeyboard = (id: number) => ({
  inline_keyboard: [[
    { text: "OK", callback_data: `ok:${id}` },
    { text: "Edit category", callback_data: `cat:${id}` },
    { text: "Delete", callback_data: `del:${id}` },
  ]],
});

const categoryKeyboard = (id: number) => ({
  inline_keyboard: Object.keys(TAXONOMY).map(c => [{ text: c, callback_data: `set:${id}:${c}` }]),
});

type Formattable = { date: string; amount_cents: number; category: string | null; subcategory: string | null; source: string | null; note: string | null };

const formatTxn = (id: number, t: Formattable) => {
  const sub = t.subcategory ? ` / ${t.subcategory}` : "";
  const src = t.source ? `  ${t.source}` : "";
  const note = t.note ? `\n${t.note}` : "";
  return `#${id}  ${money(t.amount_cents)}  ${t.date}\n${t.category ?? "?"}${sub}${src}${note}`;
};

const money = (cents: number) => `${(cents / 100).toFixed(2)} EUR`;

const backup = async (env: Env) => {
  const { results } = await db.all(env.DB);
  await env.BACKUP.put(`backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(results));
};

const digest = async (env: Env) => {
  const ym = new Date().toISOString().slice(0, 7);
  const cash = await db.cash(env.DB);
  const burn7 = await db.burn(env.DB, 7);
  const avg7 = (await db.burn(env.DB, 28)) / 4;
  const summary = await db.monthSummary(env.DB, ym);
  const lines = [
    "Weekly digest",
    `Balance ${money(cash)}, last 7 days ${money(burn7)} (4w avg ${money(avg7)})`,
    burn7 > avg7 * 1.5 && burn7 > 5000 ? `Spike: ${((burn7 / avg7 - 1) * 100).toFixed(0)}% above 4w average.` : "",
    "",
    `${ym} so far:`,
    ...summary.results.slice(0, 5).map(r => `  ${r.category}: ${money(r.cents)} (${r.n})`),
  ].filter(Boolean);
  await tg.sendMessage(env.TG_TOKEN, Number(env.TG_USER_ID), lines.join("\n"));
};
