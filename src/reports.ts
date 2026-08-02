import * as db from "./db.ts";
import { localDate } from "./time.ts";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const LUMPY_SUBCATEGORIES = new Set([
  "Rent/Mortgage", "Insurance", "Tuition & Fees", "Taxes", "Debt Repayment", "Savings & Investments",
]);

type ReportUser = Pick<db.User, "id" | "currency"> & { timezone: string };
type ChartView = { url: string; caption: string } | { text: string };

export const validMonth = (value: string): boolean => MONTH_RE.test(value);

const shiftMonth = (ym: string, delta: number): string => {
  const [year, month] = ym.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + delta, 1)).toISOString().slice(0, 7);
};

const shiftDate = (date: string, days: number): string => {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
};

const monthName = (ym: string): string => {
  const [year, month] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
};

const period = (ym: string, today: string) => ({
  from: `${ym}-01`,
  before: ym === today.slice(0, 7) ? shiftDate(today, 1) : `${shiftMonth(ym, 1)}-01`,
});

const money = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;

const signedMoney = (cents: number, currency: string) =>
  `${cents >= 0 ? "+" : "-"}${money(Math.abs(cents), currency)}`;

const percentage = (part: number, total: number) => {
  const value = total ? Math.round(part / total * 1000) / 10 : 0;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
};

const isLumpy = (row: { subcategory: string; amount_cents: number }, cutoff: number) =>
  LUMPY_SUBCATEGORIES.has(row.subcategory) || row.amount_cents >= cutoff;

const pace = async (database: D1Database, user: ReportUser, today: string) => {
  const ym = today.slice(0, 7);
  const { results: recent } = await database.prepare(
    "SELECT amount_cents FROM expenses WHERE user_id=? AND date >= ? AND date <= ? ORDER BY amount_cents"
  ).bind(user.id, shiftDate(today, -90), today).all<{ amount_cents: number }>();
  const cutoff = recent.length ? recent[Math.floor(recent.length * 0.9)].amount_cents : Infinity;
  const { results: monthRows } = await database.prepare(
    "SELECT subcategory, amount_cents FROM expenses WHERE user_id=? AND date >= ? AND date <= ?"
  ).bind(user.id, `${ym}-01`, today).all<{ subcategory: string; amount_cents: number }>();
  const nonLumpy = monthRows.filter(row => !isLumpy(row, cutoff));
  if (nonLumpy.length < 5) return null;
  const actualLumpy = monthRows
    .filter(row => isLumpy(row, cutoff))
    .reduce((sum, row) => sum + row.amount_cents, 0);

  const { results: priorRows } = await database.prepare(
    "SELECT subcategory, amount_cents FROM expenses WHERE user_id=? AND date >= ? AND date < ?"
  ).bind(user.id, `${shiftMonth(ym, -6)}-01`, `${ym}-01`).all<{ subcategory: string; amount_cents: number }>();
  const avgLumpy = Math.round(
    priorRows.filter(row => isLumpy(row, cutoff)).reduce((sum, row) => sum + row.amount_cents, 0) / 6,
  );
  const day = Number(today.slice(8, 10));
  const [year, month] = ym.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const nonLumpyCents = nonLumpy.reduce((sum, row) => sum + row.amount_cents, 0);
  const projected = Math.max(avgLumpy, actualLumpy) + Math.round(nonLumpyCents / day * daysInMonth);
  const average = await db.expectedMonthlyBurn(database, user.id, 3, ym);
  return { projected, average };
};

export const cashOverview = async (database: D1Database, user: ReportUser, requestedMonth?: string, now = new Date()) => {
  const today = localDate(user.timezone, now);
  const currentYm = today.slice(0, 7);
  const ym = requestedMonth ?? currentYm;
  const { from, before } = period(ym, today);
  const [through, month, top] = await Promise.all([
    db.cashTotalsBefore(database, user.id, before),
    db.cashTotalsBetween(database, user.id, from, before),
    db.topSubcategoriesBetween(database, user.id, from, before, 5),
  ]);
  const balance = through.income_cents - through.expense_cents;
  const net = month.income_cents - month.expense_cents;
  const current = ym === currentYm;
  const lines = [
    `${current ? "Balance" : `Balance through ${ym}`}: ${money(balance, user.currency)}`,
    `${money(through.income_cents, user.currency)} income - ${money(through.expense_cents, user.currency)} expenses`,
    "",
    `${monthName(ym)}${current ? ` through ${today}` : ""}`,
    `Income: ${money(month.income_cents, user.currency)}`,
    `Expenses: ${money(month.expense_cents, user.currency)}`,
    `Net: ${signedMoney(net, user.currency)}`,
  ];

  if (current) {
    const [burn, paceData] = await Promise.all([
      db.expectedMonthlyBurn(database, user.id, 12, ym),
      pace(database, user, today),
    ]);
    const runway = burn > 0 ? Math.max(0, balance / burn).toFixed(1) + " months" : "infinite";
    lines.push(
      "",
      `Burn: ${money(Math.round(burn), user.currency)}/month`,
      `Runway: ${runway}`,
    );
    if (paceData) {
      const delta = paceData.projected - paceData.average;
      lines.push(
        `Projected expenses: ${money(paceData.projected, user.currency)} (${signedMoney(delta, user.currency)} vs 3-month average)`,
      );
    }
  }

  if (top.results.length) {
    lines.push(
      "",
      "Top spending",
      ...top.results.map(row =>
        `${row.category} / ${row.subcategory}: ${money(row.cents, user.currency)}  ${percentage(row.cents, month.expense_cents)}`
      ),
    );
  }
  return lines.join("\n");
};

const quickChartUrl = (config: Record<string, unknown>) => {
  const params = new URLSearchParams({
    version: "4",
    width: "900",
    height: "560",
    devicePixelRatio: "2",
    backgroundColor: "#f8fafc",
    c: JSON.stringify(config),
  });
  return `https://quickchart.io/chart?${params}`;
};

const chartOptions = (title: string) => ({
  responsive: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    title: { display: true, text: title, color: "#0f172a", font: { size: 20, weight: "bold" }, padding: 20 },
    legend: { position: "bottom", labels: { color: "#334155", usePointStyle: true, padding: 18 } },
  },
});

const trajectoryChart = async (database: D1Database, user: ReportUser, today: string): Promise<ChartView> => {
  const currentYm = today.slice(0, 7);
  const months = Array.from({ length: 12 }, (_, index) => shiftMonth(currentYm, index - 11));
  const from = `${months[0]}-01`;
  const before = shiftDate(today, 1);
  const [opening, flow] = await Promise.all([
    db.cashTotalsBefore(database, user.id, from),
    db.monthlyCashflowBetween(database, user.id, from, before),
  ]);
  const byMonth = new Map(flow.results.map(row => [row.ym, row]));
  const incomes = months.map(ym => byMonth.get(ym)?.income_cents ?? 0);
  const expenses = months.map(ym => byMonth.get(ym)?.expense_cents ?? 0);
  if (![...incomes, ...expenses].some(Boolean)) return { text: "No income or expenses in the last 12 months." };

  let balance = opening.income_cents - opening.expense_cents;
  const balances = months.map((_, index) => balance += incomes[index] - expenses[index]);
  const net = incomes.reduce((sum, value, index) => sum + value - expenses[index], 0);
  const labels = months.map((ym, index) => `${monthName(ym).slice(0, 3)}${index === months.length - 1 ? "*" : ""}`);
  const incomeColors = months.map((_, index) => index === months.length - 1 ? "rgba(22, 163, 74, 0.38)" : "rgba(22, 163, 74, 0.82)");
  const expenseColors = months.map((_, index) => index === months.length - 1 ? "rgba(239, 68, 68, 0.38)" : "rgba(239, 68, 68, 0.78)");
  const config = {
    type: "bar",
    data: {
      labels,
      datasets: [
        { type: "bar", label: `Income (${user.currency})`, data: incomes.map(v => v / 100), backgroundColor: incomeColors, borderRadius: 4, yAxisID: "flow" },
        { type: "bar", label: `Expenses (${user.currency})`, data: expenses.map(v => -v / 100), backgroundColor: expenseColors, borderRadius: 4, yAxisID: "flow" },
        { type: "line", label: `Balance (${user.currency})`, data: balances.map(v => v / 100), borderColor: "#2563eb", backgroundColor: "#2563eb", borderWidth: 3, pointRadius: 3, tension: 0.25, yAxisID: "balance" },
      ],
    },
    options: {
      ...chartOptions("12-month cash trajectory"),
      scales: {
        x: { grid: { display: false }, ticks: { color: "#475569" } },
        flow: { position: "left", grid: { color: "rgba(148, 163, 184, 0.22)" }, ticks: { color: "#475569" } },
        balance: { position: "right", grid: { drawOnChartArea: false }, ticks: { color: "#2563eb" } },
      },
    },
  };
  return {
    url: quickChartUrl(config),
    caption: `Balance ${money(balances.at(-1)!, user.currency)} · 12-month net ${signedMoney(net, user.currency)}\n* Current month through ${today}`,
  };
};

const spendingChart = async (database: D1Database, user: ReportUser, today: string): Promise<ChartView> => {
  const currentYm = today.slice(0, 7);
  const months = Array.from({ length: 6 }, (_, index) => shiftMonth(currentYm, index - 5));
  const { results } = await db.monthlySubcategoriesBetween(database, user.id, `${months[0]}-01`, shiftDate(today, 1));
  if (!results.length) return { text: "No expenses in the last six months." };

  const key = (category: string, subcategory: string) => `${category}\u0000${subcategory}`;
  const label = (value: string) => value.replace("\u0000", " / ");
  const totals = new Map<string, number>();
  const values = new Map<string, Map<string, number>>();
  for (const row of results) {
    const pair = key(row.category, row.subcategory);
    totals.set(pair, (totals.get(pair) ?? 0) + row.cents);
    if (!values.has(pair)) values.set(pair, new Map());
    values.get(pair)!.set(row.ym, row.cents);
  }
  const top = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([pair]) => pair);
  const otherByMonth = new Map(months.map(ym => [ym, 0]));
  for (const [pair, monthValues] of values) {
    if (top.includes(pair)) continue;
    for (const [ym, cents] of monthValues) otherByMonth.set(ym, (otherByMonth.get(ym) ?? 0) + cents);
  }
  const series = [
    ...top.map(pair => ({ name: label(pair), values: months.map(ym => values.get(pair)?.get(ym) ?? 0) })),
    ...(Math.max(...otherByMonth.values()) > 0 ? [{ name: "Other", values: months.map(ym => otherByMonth.get(ym) ?? 0) }] : []),
  ];
  const colors = ["37, 99, 235", "13, 148, 136", "245, 158, 11", "139, 92, 246", "239, 68, 68", "100, 116, 139"];
  const datasets = series.map((item, seriesIndex) => ({
    label: item.name,
    data: item.values.map(value => value / 100),
    backgroundColor: months.map((_, monthIndex) => `rgba(${colors[seriesIndex]}, ${monthIndex === months.length - 1 ? 0.38 : 0.82})`),
    borderWidth: 0,
  }));
  const previous = months.length - 2;
  const prior = months.length - 3;
  const changed = [...values]
    .map(([pair, monthValues]) => ({
      name: label(pair),
      cents: (monthValues.get(months[previous]) ?? 0) - (monthValues.get(months[prior]) ?? 0),
    }))
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents) || a.name.localeCompare(b.name))[0];
  const change = changed.cents === 0
    ? `No spending change from ${monthName(months[prior])} to ${monthName(months[previous])}.`
    : `Largest change from ${monthName(months[prior])} to ${monthName(months[previous])}: ${changed.name} ${signedMoney(changed.cents, user.currency)}.`;
  const config = {
    type: "bar",
    data: { labels: months.map((ym, index) => `${monthName(ym).slice(0, 3)}${index === months.length - 1 ? "*" : ""}`), datasets },
    options: {
      ...chartOptions("Six-month spending mix"),
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: "#475569" } },
        y: { stacked: true, beginAtZero: true, grid: { color: "rgba(148, 163, 184, 0.22)" }, ticks: { color: "#475569" } },
      },
    },
  };
  return { url: quickChartUrl(config), caption: `${change}\n* Current month through ${today}` };
};

export const chartView = async (database: D1Database, user: ReportUser, args: string[], now = new Date()): Promise<ChartView> => {
  const today = localDate(user.timezone, now);
  if (!args.length) return trajectoryChart(database, user, today);
  if (args.length === 1 && args[0].toLowerCase() === "spending") return spendingChart(database, user, today);
  return { text: "Usage: /chart [spending]" };
};
