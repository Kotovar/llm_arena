import type { Order, OrderItem, PriceBreakdown } from "./types.ts";

const MAX_DISCOUNT_PERCENT = 30;
const FREE_STANDARD_DELIVERY_FROM = 7500;
const SMALL_ORDER_LIMIT = 1500;
const SMALL_ORDER_FEE = 300;
const GIFT_WRAP_PER_UNIT = 150;
const GIFT_WRAP_MAX = 1000;

/** Процент от суммы в центах, округлённый до цента. */
function percent(amount: number, pct: number): number {
  return Math.round((amount * pct) / 100);
}

function sumOf(items: readonly OrderItem[], category?: OrderItem["category"]): number {
  return items.filter((item) => !category || item.category === category).reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
}

function customerDiscount(order: Order, subtotal: number): number {
  const { type, loyaltyYears } = order.customer;
  if (type === "vip") return percent(subtotal, Math.min(15, 10 + Math.max(0, loyaltyYears - 2)));
  if (type === "employee") return percent(Math.max(0, subtotal - sumOf(order.items, "electronics")), 20);
  return loyaltyYears >= 5 ? percent(subtotal, 3) : 0;
}

/** Промокод считается от суммы после скидки клиента; сотрудникам не действует. */
function promoDiscount(order: Order, subtotal: number, discounted: number): { code: string; amount: number } | null {
  if (!order.promoCode || order.customer.type === "employee") return null;
  const code = order.promoCode.trim().toUpperCase();
  if (code === "SAVE10" && subtotal >= 5000) return { code, amount: percent(discounted, 10) };
  if (code === "FLAT5" && discounted >= 2000) return { code, amount: 500 };
  const books = sumOf(order.items, "books");
  if (code === "BOOKS20" && books > 0) return { code, amount: percent(books, 20) };
  return null;
}

function deliveryPrice(order: Order, afterDiscount: number): number {
  if (order.delivery === "standard") return afterDiscount >= FREE_STANDARD_DELIVERY_FROM ? 0 : 499;
  if (order.delivery === "express") return order.customer.type === "vip" ? 799 : 1299;
  return 0;
}

function fees(order: Order, afterDiscount: number): number {
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const giftWrap = order.giftWrap ? Math.min(units * GIFT_WRAP_PER_UNIT, GIFT_WRAP_MAX) : 0;
  const smallOrder = order.delivery !== "pickup" && afterDiscount < SMALL_ORDER_LIMIT ? SMALL_ORDER_FEE : 0;
  return giftWrap + smallOrder;
}

export function calculateOrderTotal(order: Order): PriceBreakdown {
  if (order.items.length === 0) {
    return { subtotal: 0, discount: 0, appliedPromo: null, delivery: 0, fees: 0, total: 0 };
  }
  const subtotal = sumOf(order.items);
  const byCustomer = customerDiscount(order, subtotal);
  const promo = promoDiscount(order, subtotal, subtotal - byCustomer);
  const discount = Math.min(byCustomer + (promo?.amount ?? 0), percent(subtotal, MAX_DISCOUNT_PERCENT));
  const afterDiscount = subtotal - discount;
  const delivery = deliveryPrice(order, afterDiscount);
  const extra = fees(order, afterDiscount);
  return { subtotal, discount, appliedPromo: promo?.code ?? null, delivery, fees: extra, total: afterDiscount + delivery + extra };
}
