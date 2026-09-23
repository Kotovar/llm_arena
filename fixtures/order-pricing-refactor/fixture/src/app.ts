import { calculateOrderTotal, formatMoney, formatReceipt, type Order } from "./index.ts";

const regular = { type: "regular", loyaltyYears: 0 } as const;

/** Показательные заказы: у каждого своя ветка расчёта. */
const samples: Array<[string, Order]> = [
  ["Обычный, стандартная доставка", { customer: regular, items: [{ sku: "tea", category: "food", priceCents: 1250, quantity: 2 }], delivery: "standard" }],
  ["VIP 5 лет + SAVE10", { customer: { type: "vip", loyaltyYears: 5 }, items: [{ sku: "tv", category: "electronics", priceCents: 12_345, quantity: 1 }], delivery: "standard", promoCode: "save10" }],
  ["Сотрудник: электроника без скидки, промокод не действует", { customer: { type: "employee", loyaltyYears: 3 }, items: [{ sku: "phone", category: "electronics", priceCents: 50_000, quantity: 1 }, { sku: "bread", category: "food", priceCents: 333, quantity: 3 }], delivery: "express", promoCode: "FLAT5" }],
  ["Скидка упирается в 30%", { customer: { type: "vip", loyaltyYears: 9 }, items: [{ sku: "book", category: "books", priceCents: 3000, quantity: 1 }], delivery: "pickup", promoCode: "BOOKS20" }],
  ["Бесплатная доставка ровно от $75", { customer: regular, items: [{ sku: "a", category: "food", priceCents: 7500, quantity: 1 }], delivery: "standard" }],
  ["Порог доставки после скидки", { customer: regular, items: [{ sku: "a", category: "food", priceCents: 8000, quantity: 1 }], delivery: "standard", promoCode: " SAVE10 " }],
  ["Маленький заказ + упаковка", { customer: regular, items: [{ sku: "a", category: "food", priceCents: 100, quantity: 12 }], delivery: "standard", giftWrap: true }],
  ["Экспресс VIP", { customer: { type: "vip", loyaltyYears: 0 }, items: [{ sku: "a", category: "food", priceCents: 9000, quantity: 1 }], delivery: "express" }],
  ["Пустой заказ", { customer: { type: "vip", loyaltyYears: 4 }, items: [], delivery: "standard", giftWrap: true }],
];

/** Детерминированный генератор: одни и те же заказы при каждом открытии страницы. */
function random(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

function randomOrder(next: () => number): Order {
  return {
    customer: { type: pick(next, ["regular", "vip", "employee"] as const), loyaltyYears: Math.floor(next() * 11) },
    items: Array.from({ length: pick(next, [0, 1, 2, 3]) }, (_, index) => ({
      sku: `sku-${index}`,
      category: pick(next, ["food", "electronics", "books"] as const),
      priceCents: 1 + Math.floor(next() * 12_000),
      quantity: pick(next, [1, 2, 3, 7, 12]),
    })),
    delivery: pick(next, ["pickup", "standard", "express"] as const),
    promoCode: pick(next, [undefined, "SAVE10", "flat5", " BOOKS20", "WELCOME"]),
    giftWrap: pick(next, [undefined, true]),
  };
}

/** Отпечаток поведения: SHA-256 от всех результатов подряд. Совпал — совпали все расчёты. */
async function fingerprint(count: number): Promise<string> {
  const next = random(20_260_923);
  const results = Array.from({ length: count }, () => calculateOrderTotal(randomOrder(next)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(results)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function cell(text: string, tag: "td" | "th" = "td") {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

export async function mountDemo(root: HTMLElement) {
  root.querySelector<HTMLElement>("#samples")!.replaceChildren(...samples.map(([title, order]) => {
    const price = calculateOrderTotal(order);
    const row = document.createElement("tr");
    const receipt = cell(formatReceipt(order));
    receipt.className = "receipt";
    row.append(cell(title, "th"), cell(formatMoney(price.subtotal)), cell(price.discount ? `−${formatMoney(price.discount)}` : "—"), cell(price.appliedPromo ?? "—"), cell(formatMoney(price.delivery)), cell(formatMoney(price.fees)), cell(formatMoney(price.total)), receipt);
    return row;
  }));
  root.querySelector<HTMLElement>("#fingerprint")!.textContent = await fingerprint(2000);
}
