import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import * as api from "./src/index.ts";
import { calculateOrderTotal as direct } from "./src/calculateOrderTotal.ts";
import { referenceOrderTotal } from "./pricing-reference.ts";
import type { Order } from "./src/types.ts";

const { calculateOrderTotal } = api;

/** Детерминированный генератор: один и тот же набор заказов при каждом запуске. */
function random(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)]!;
}

const prices = [1, 5, 99, 333, 499, 1000, 1499, 1500, 1999, 2000, 2345, 4999, 5000, 7499, 7500, 12_345];
const promos = [undefined, "", "SAVE10", "save10", "  FLAT5 ", "flat5", "BOOKS20", "Books20", "WELCOME", "SAVE 10"];

function randomOrder(next: () => number): Order {
  const count = pick(next, [0, 1, 1, 2, 3, 5]);
  return {
    customer: { type: pick(next, ["regular", "vip", "employee"] as const), loyaltyYears: Math.floor(next() * 11) },
    items: Array.from({ length: count }, (_, index) => ({
      sku: `sku-${index}`,
      category: pick(next, ["food", "electronics", "books"] as const),
      priceCents: next() < 0.6 ? pick(next, prices) : 1 + Math.floor(next() * 20_000),
      quantity: pick(next, [1, 1, 1, 2, 3, 7, 12]),
    })),
    delivery: pick(next, ["pickup", "standard", "express"] as const),
    promoCode: pick(next, promos),
    giftWrap: pick(next, [undefined, false, true]),
  };
}

test("совпадает с исходной реализацией на 20 000 случайных заказов", () => {
  const next = random(20_260_923);
  for (let i = 0; i < 20_000; i++) {
    const order = randomOrder(next);
    deepEqual(calculateOrderTotal(structuredClone(order)), referenceOrderTotal(structuredClone(order)), `заказ ${JSON.stringify(order)}`);
  }
});

/** Именованные комбинации, которых нет в публичных тестах: у каждой — своё место, где легко ошибиться. */
const cases: Array<[string, Order]> = [
  ["VIP со стажем и SAVE10 — промокод от суммы после скидки клиента", {
    customer: { type: "vip", loyaltyYears: 5 },
    items: [{ sku: "tv", category: "electronics", priceCents: 12_345, quantity: 1 }],
    delivery: "standard",
    promoCode: "save10",
  }],
  ["потолок скидки VIP — 15%", { customer: { type: "vip", loyaltyYears: 10 }, items: [{ sku: "a", category: "food", priceCents: 9999, quantity: 1 }], delivery: "pickup" }],
  ["VIP ровно два года — без надбавки", { customer: { type: "vip", loyaltyYears: 2 }, items: [{ sku: "a", category: "food", priceCents: 9999, quantity: 1 }], delivery: "pickup" }],
  ["сотруднику промокод не действует", {
    customer: { type: "employee", loyaltyYears: 0 },
    items: [{ sku: "book", category: "books", priceCents: 4000, quantity: 2 }],
    delivery: "pickup",
    promoCode: "BOOKS20",
  }],
  ["скидка сотрудника не касается электроники", {
    customer: { type: "employee", loyaltyYears: 3 },
    items: [{ sku: "phone", category: "electronics", priceCents: 50_000, quantity: 1 }, { sku: "bread", category: "food", priceCents: 333, quantity: 3 }],
    delivery: "express",
  }],
  ["общая скидка упирается в 30%", {
    customer: { type: "vip", loyaltyYears: 9 },
    items: [{ sku: "book", category: "books", priceCents: 3000, quantity: 1 }],
    delivery: "pickup",
    promoCode: "BOOKS20",
  }],
  ["бесплатная доставка ровно от 75", { customer: { type: "regular", loyaltyYears: 0 }, items: [{ sku: "a", category: "food", priceCents: 7500, quantity: 1 }], delivery: "standard" }],
  ["порог доставки считается после скидок", { customer: { type: "regular", loyaltyYears: 0 }, items: [{ sku: "a", category: "food", priceCents: 8000, quantity: 1 }], delivery: "standard", promoCode: "SAVE10" }],
  ["экспресс для VIP дешевле", { customer: { type: "vip", loyaltyYears: 0 }, items: [{ sku: "a", category: "food", priceCents: 9000, quantity: 1 }], delivery: "express" }],
  ["экспресс не бывает бесплатным", { customer: { type: "regular", loyaltyYears: 0 }, items: [{ sku: "a", category: "food", priceCents: 90_000, quantity: 1 }], delivery: "express" }],
  ["SAVE10 не действует ниже 50", { customer: { type: "regular", loyaltyYears: 0 }, items: [{ sku: "a", category: "food", priceCents: 4999, quantity: 1 }], delivery: "pickup", promoCode: "SAVE10" }],
  ["SAVE10 ровно от 50", { customer: { type: "regular", loyaltyYears: 0 }, items: [{ sku: "a", category: "food", priceCents: 5000, quantity: 1 }], delivery: "pickup", promoCode: "SAVE10" }],
  ["FLAT5 смотрит на сумму после скидки клиента", { customer: { type: "regular", loyaltyYears: 6 }, items: [{ sku: "a", category: "food", priceCents: 2050, quantity: 1 }], delivery: "pickup", promoCode: "FLAT5" }],
  ["неизвестный промокод игнорируется", { customer: { type: "regular", loyaltyYears: 0 }, items: [{ sku: "a", category: "food", priceCents: 6000, quantity: 1 }], delivery: "pickup", promoCode: "WELCOME" }],
  ["сбор за маленький заказ — не при самовывозе", { customer: { type: "regular", loyaltyYears: 0 }, items: [{ sku: "a", category: "food", priceCents: 1499, quantity: 1 }], delivery: "pickup" }],
  ["сбор за маленький заказ — после скидок", { customer: { type: "regular", loyaltyYears: 0 }, items: [{ sku: "a", category: "food", priceCents: 1600, quantity: 1 }], delivery: "standard", promoCode: "FLAT5" }],
  ["упаковка — за штуку, не больше 10", { customer: { type: "regular", loyaltyYears: 0 }, items: [{ sku: "a", category: "food", priceCents: 100, quantity: 12 }], delivery: "standard", giftWrap: true }],
  ["округление процента до цента", { customer: { type: "regular", loyaltyYears: 5 }, items: [{ sku: "a", category: "food", priceCents: 1650, quantity: 1 }, { sku: "b", category: "books", priceCents: 1, quantity: 3 }], delivery: "pickup" }],
  ["пустой заказ бесплатен при любой доставке", { customer: { type: "vip", loyaltyYears: 4 }, items: [], delivery: "standard", giftWrap: true, promoCode: "FLAT5" }],
];

for (const [name, order] of cases) {
  test(name, () => {
    deepEqual(calculateOrderTotal(structuredClone(order)), referenceOrderTotal(structuredClone(order)));
  });
}

test("не меняет входной заказ", () => {
  for (const [, order] of cases) {
    const copy = structuredClone(order);
    calculateOrderTotal(copy);
    deepEqual(copy, order);
  }
});

test("публичный API на месте", () => {
  equal(typeof api.calculateOrderTotal, "function");
  equal(typeof api.formatReceipt, "function");
  equal(typeof api.formatMoney, "function");
  equal(direct, api.calculateOrderTotal);
});
