import { TAXONOMY, isCategory, isSubcategory, type Category } from "./taxonomy";

export type Extracted = {
  date: string;
  amount_cents: number;
  category: Category;
  subcategory: string | null;
  source: string | null;
  note: string;
};

const ROUTER = "https://router.huggingface.co/v1/chat/completions";
const MODEL = "google/gemma-4-31B-it:fastest";

const taxonomyBlock = Object.entries(TAXONOMY)
  .map(([c, subs]) => subs.length ? `  ${c} -> ${subs.join(", ")}` : `  ${c}`)
  .join("\n");

const systemPrompt = (today: string) => `Extract one expense from the user's message (image, text, or both). Return strict JSON only.

Fields:
  date: ISO YYYY-MM-DD. If the year is missing, use ${today.slice(0, 4)}. If the resulting date is in the future, subtract one year.
  amount_cents: integer EUR cents. Convert foreign currencies to EUR using your best estimate; mention the original currency in note.
  category: exactly one of these. subcategory: must match the chosen category from this list, or null.
${taxonomyBlock}
  source: one of "Cash", "Revolut", "Wise", "S Bank", "Kuveyt Turk", or null. Infer from screenshot brand if visible.
  note: short itemized list (e.g., "vegetables, milk, bread") or merchant name.

If the user's text contradicts the image, the text wins.`;

export const extract = async (
  hfToken: string,
  imageUrl: string | null,
  text: string,
  today: string,
): Promise<Extracted | null> => {
  const userContent: object[] = [];
  if (imageUrl) userContent.push({ type: "image_url", image_url: { url: imageUrl } });
  userContent.push({ type: "text", text: text || "Extract this expense." });

  const res = await fetch(ROUTER, {
    method: "POST",
    headers: { Authorization: `Bearer ${hfToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt(today) },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`hf ${res.status}`);
  const { choices } = await res.json() as { choices: { message: { content: string } }[] };
  return validate(JSON.parse(choices[0].message.content), today);
};

const validate = (raw: unknown, today: string): Extracted | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
  if (typeof r.amount_cents !== "number" || !Number.isInteger(r.amount_cents) || r.amount_cents <= 0) return null;
  if (typeof r.category !== "string" || !isCategory(r.category)) return null;
  const subcategory = typeof r.subcategory === "string" && isSubcategory(r.category, r.subcategory) ? r.subcategory : null;
  return {
    date: r.date > today ? shiftYear(r.date, -1) : r.date,
    amount_cents: r.amount_cents,
    category: r.category,
    subcategory,
    source: typeof r.source === "string" ? r.source : null,
    note: typeof r.note === "string" ? r.note : "",
  };
};

const shiftYear = (iso: string, delta: number): string =>
  `${parseInt(iso.slice(0, 4)) + delta}${iso.slice(4)}`;
