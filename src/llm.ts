import { TAXONOMY, isCategory, isSubcategory, type Category } from "./taxonomy.ts";
import { isIsoDate } from "./time.ts";

export type ExtractedExpense = {
  kind: "expense";
  date: string;
  amount_cents: number;
  category: Category;
  subcategory: string;
  source: string | null;
  note: string;
};

export type ExtractedIncome = {
  kind: "income";
  date: string;
  amount_cents: number;
  source: string | null;
  note: string | null;
};

export type Extracted = ExtractedExpense | ExtractedIncome;

type RawCommon = {
  date: string;
  amount: number;
  currency: string;
  source: string | null;
  note: string;
};

type RawExpense = RawCommon & {
  kind: "expense";
  category: Category;
  subcategory: string | null;
};

type RawIncome = RawCommon & { kind: "income" };
type Raw = RawExpense | RawIncome;
type ExtractMode = "mixed" | "income";

const ROUTER = "https://router.huggingface.co/v1/chat/completions";
const MODEL = "google/gemma-4-31B-it:deepinfra";
const FX = "https://api.frankfurter.dev/v1";
const FX_FALLBACK = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api";

const complete = async <T>(hfToken: string, body: object): Promise<T> => {
  const res = await fetch(ROUTER, {
    method: "POST",
    headers: { Authorization: `Bearer ${hfToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, ...body }),
  });
  if (!res.ok) throw new Error(`hf ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const { choices } = await res.json() as { choices: { message: T }[] };
  return choices[0].message;
};

const taxonomyBlock = Object.entries(TAXONOMY)
  .map(([c, subs]) => `  ${c} -> ${subs.join(", ")}`)
  .join("\n");

const systemPrompt = (today: string, primaryCcy: string, mode: ExtractMode) => `Today is ${today}. Extract ${mode === "income" ? "only clear additions of money" : "financial transactions"} from the user's message (image, text, or both). Return strict JSON: {"transactions": [<transaction>, ...]}.

A clear addition of money is income, including salary, bonuses, freelance payments, reimbursements, refunds, gifts, and similar credits. Do not guess that something is income when the addition is unclear.${mode === "income" ? " Do not return expenses." : " Money spent is an expense."}

Return one transaction per distinct transaction. A single receipt with multiple items is ONE expense (list items in note). A screenshot can contain several expenses and incomes. Preserve their order. If there's nothing extractable, return {"transactions": []} rather than guessing.

Each transaction:
  kind: exactly "expense" or "income".
  date: ISO YYYY-MM-DD. If neither image nor text shows a date, use today (${today}). If only day or month/day is given, fill missing parts from today. If the resulting date is in the future, subtract one year.
  amount: positive number in the stated currency. Do not convert.
  currency: 3-letter ISO code (EUR, USD, TRY, GBP, ...). Use ${primaryCcy} if not specified.

Each expense:
  category: exactly one of these top-level names.
  subcategory: REQUIRED. Pick the closest subcategory from the chosen category's list below. Never null, never blank.
${taxonomyBlock}
  source: payment method as a short free-text string if the user or screenshot explicitly states it (e.g., "Cash", "Revolut", a bank name). Otherwise null. Do not guess from merchant names.
  note: short itemized list (e.g., "vegetables, milk, bread") or merchant name.

Each income:
  source: short human-readable description of where the money came from (e.g., "JYU Salary", "Bonus from S Market"). Use null only when the origin is unavailable.
  note: short additional context, or an empty string.

If the user's text contradicts the image, the text wins.`;

export const extract = async (
  hfToken: string,
  imageUrl: string | null,
  text: string,
  today: string,
  primaryCcy: string,
  mode: ExtractMode = "mixed",
): Promise<Extracted[]> => {
  const userContent: object[] = [];
  if (imageUrl) userContent.push({ type: "image_url", image_url: { url: imageUrl } });
  userContent.push({ type: "text", text: text || (mode === "income" ? "Extract this income." : "Extract these transactions.") });

  const message = await complete<{ content: string }>(hfToken, {
    messages: [
      { role: "system", content: systemPrompt(today, primaryCcy, mode) },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
  });
  const parsed = JSON.parse(message.content) as { transactions?: unknown[] };
  const raws = (parsed.transactions ?? []).map(r => validate(r, today, mode)).filter((x): x is Raw => x !== null);

  const missing = raws.filter((r): r is RawExpense => r.kind === "expense" && r.subcategory === null);
  if (missing.length) {
    const filled = await fillSubcats(hfToken, imageUrl, text, missing);
    missing.forEach((r, idx) => {
      const sub = filled[idx];
      if (sub && isSubcategory(r.category, sub)) r.subcategory = sub;
    });
  }

  const valid = raws.filter((r): r is RawIncome | (RawExpense & { subcategory: string }) =>
    r.kind === "income" || r.subcategory !== null
  );
  const rates = await resolveRates(valid, primaryCcy);
  return valid.map(r => toExtracted(r, primaryCcy, rates));
};

const rateKey = (ccy: string, date: string) => `${ccy}|${date}`;

// One FX lookup per distinct (currency, date), not per expense: a 30-line bank list is one rate, not thirty.
const resolveRates = async (raws: Raw[], primaryCcy: string): Promise<Map<string, number>> => {
  const keys = [...new Set(raws.map(r => rateKey(r.currency, r.date)))];
  const entries = await Promise.all(keys.map(async key => {
    const [ccy, date] = key.split("|");
    return [key, await rate(ccy, date, primaryCcy)] as const;
  }));
  return new Map(entries);
};

const fillSubcats = async (
  hfToken: string,
  imageUrl: string | null,
  text: string,
  missing: RawExpense[],
): Promise<(string | null)[]> => {
  const block = missing.map((m, i) =>
    `${i}: amount ${m.amount} ${m.currency} on ${m.date}, category "${m.category}", note "${m.note}"\n   pick from: ${TAXONOMY[m.category].join(", ")}`
  ).join("\n");
  const userContent: object[] = [];
  if (imageUrl) userContent.push({ type: "image_url", image_url: { url: imageUrl } });
  userContent.push({ type: "text", text: text || "Pick subcategories from the original media." });

  let message: { content: string };
  try {
    message = await complete(hfToken, {
      messages: [
        { role: "system", content: `Each item below already has a category but no subcategory. Pick exactly one subcategory from the allowed list for each. Return strict JSON: {"subcategories": [<string>, ...]} in the same order as the items.\n\n${block}` },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("hf ")) return missing.map(() => null);
    throw e;
  }
  const parsed = JSON.parse(message.content) as { subcategories?: unknown[] };
  const subs = parsed.subcategories ?? [];
  return missing.map((_, i) => typeof subs[i] === "string" ? subs[i] as string : null);
};

const toExtracted = (r: RawIncome | (RawExpense & { subcategory: string }), primaryCcy: string, rates: Map<string, number>): Extracted => {
  const cents = Math.round(r.amount * rates.get(rateKey(r.currency, r.date))! * 100);
  const note = r.currency === primaryCcy ? r.note : appendFx(r.note, r.amount, r.currency);
  if (r.kind === "income") return { kind: "income", date: r.date, amount_cents: cents, source: r.source, note: note || null };
  return { kind: "expense", date: r.date, amount_cents: cents, category: r.category, subcategory: r.subcategory, source: r.source, note };
};

const rate = async (ccy: string, date: string, primaryCcy: string): Promise<number> => {
  if (ccy === primaryCcy) return 1;
  const res = await fetch(`${FX}/${date}?from=${ccy}&to=${primaryCcy}`);
  if (res.ok) {
    const { rates } = await res.json() as { rates: Record<string, number> };
    if (rates[primaryCcy]) return rates[primaryCcy];
  }
  return fallbackRate(ccy, date, primaryCcy); // Frankfurter only covers 30 ECB currencies; this one has 340+ incl. SYP
};

// Date-keyed, so the SYP redenomination (100 old = 1 new, Jan 2026) is handled by whichever denomination was current on the receipt date.
const fallbackRate = async (ccy: string, date: string, primaryCcy: string): Promise<number> => {
  const from = ccy.toLowerCase(), to = primaryCcy.toLowerCase();
  const res = await fetch(`${FX_FALLBACK}@${date}/v1/currencies/${from}.json`);
  if (!res.ok) throw new Error(`fx ${ccy} ${res.status}`);
  const data = await res.json() as Record<string, Record<string, number>>;
  const r = data[from]?.[to];
  if (!r) throw new Error(`fx ${ccy}->${primaryCcy} missing`);
  return r;
};

const appendFx = (note: string, amount: number, ccy: string) => {
  const fx = `${amount.toFixed(2)} ${ccy}`;
  return note ? `${note} (${fx})` : fx;
};

const validate = (raw: unknown, today: string, mode: ExtractMode): Raw | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "expense" && r.kind !== "income") return null;
  if (mode === "income" && r.kind !== "income") return null;
  if (typeof r.date !== "string" || !isIsoDate(r.date)) return null;
  if (typeof r.amount !== "number" || !(r.amount > 0)) return null;
  if (typeof r.currency !== "string" || !/^[A-Z]{3}$/.test(r.currency)) return null;
  const common = {
    date: r.date > today ? shiftYear(r.date, -1) : r.date,
    amount: r.amount,
    currency: r.currency,
    source: typeof r.source === "string" ? r.source : null,
    note: typeof r.note === "string" ? r.note : "",
  };
  if (r.kind === "income") return { kind: "income", ...common };
  if (typeof r.category !== "string" || !isCategory(r.category)) return null;
  const subcategory = typeof r.subcategory === "string" && isSubcategory(r.category, r.subcategory) ? r.subcategory : null;
  return {
    kind: "expense",
    ...common,
    category: r.category,
    subcategory,
  };
};

const shiftYear = (iso: string, delta: number): string =>
  `${parseInt(iso.slice(0, 4)) + delta}${iso.slice(4)}`;

export const chat = async (hfToken: string, system: string, user: string): Promise<string> => {
  const message = await complete<{ content: string }>(hfToken, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return message.content.trim();
};

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type AssistantMessage = { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

export type Tool = { type: "function"; function: { name: string; description: string; parameters: object } };

export const chatWithTools = async (
  hfToken: string,
  messages: ChatMessage[],
  tools: Tool[],
  handler: (name: string, args: unknown) => Promise<unknown>,
  maxToolRounds = 8,
): Promise<string> => {
  const transcript: ChatMessage[] = [...messages];
  for (let i = 0; i < maxToolRounds; i++) {
    const msg = await complete<AssistantMessage>(hfToken, {
      messages: transcript,
      tools,
      tool_choice: "auto",
    });
    if (!msg.tool_calls?.length) return (msg.content ?? "").trim();
    transcript.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      let result: unknown;
      try {
        const args = JSON.parse(call.function.arguments);
        result = await handler(call.function.name, args);
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      transcript.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  const final = await complete<AssistantMessage>(hfToken, {
    messages: transcript,
  });
  return (final.content ?? "I couldn't produce an answer from the available data.").trim();
};
