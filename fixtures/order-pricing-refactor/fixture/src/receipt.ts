import { calculateOrderTotal } from "./calculateOrderTotal.ts";
import type { Order } from "./types.ts";

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Чек заказа: по строке на каждую часть расчёта. */
export function formatReceipt(order: Order): string {
  const price = calculateOrderTotal(order);
  const lines = [`Subtotal: ${formatMoney(price.subtotal)}`];
  if (price.discount) lines.push(`Discount${price.appliedPromo ? ` (${price.appliedPromo})` : ""}: -${formatMoney(price.discount)}`);
  lines.push(`Delivery: ${price.delivery ? formatMoney(price.delivery) : "free"}`);
  if (price.fees) lines.push(`Fees: ${formatMoney(price.fees)}`);
  lines.push(`Total: ${formatMoney(price.total)}`);
  return lines.join("\n");
}
