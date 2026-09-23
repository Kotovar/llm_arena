import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { calculateOrderTotal, formatReceipt, type Order } from "../src/index.ts";

const regular = { type: "regular", loyaltyYears: 0 } as const;

test("обычный заказ со стандартной доставкой", () => {
  deepEqual(calculateOrderTotal({
    customer: regular,
    items: [{ sku: "tea", category: "food", priceCents: 1250, quantity: 2 }],
    delivery: "standard",
  }), { subtotal: 2500, discount: 0, appliedPromo: null, delivery: 499, fees: 0, total: 2999 });
});

test("скидка VIP", () => {
  const price = calculateOrderTotal({
    customer: { type: "vip", loyaltyYears: 1 },
    items: [{ sku: "lamp", category: "electronics", priceCents: 4000, quantity: 1 }],
    delivery: "pickup",
  });
  equal(price.discount, 400);
  equal(price.total, 3600);
});

test("промокод FLAT5", () => {
  const price = calculateOrderTotal({
    customer: regular,
    items: [{ sku: "novel", category: "books", priceCents: 3000, quantity: 1 }],
    delivery: "pickup",
    promoCode: "FLAT5",
  });
  equal(price.appliedPromo, "FLAT5");
  equal(price.total, 2500);
});

test("пустой заказ ничего не стоит", () => {
  equal(calculateOrderTotal({ customer: regular, items: [], delivery: "express" }).total, 0);
});

test("чек", () => {
  const order: Order = {
    customer: regular,
    items: [{ sku: "novel", category: "books", priceCents: 3000, quantity: 1 }],
    delivery: "standard",
    promoCode: "flat5",
  };
  equal(formatReceipt(order), "Subtotal: $30.00\nDiscount (FLAT5): -$5.00\nDelivery: $4.99\nTotal: $29.99");
});
