import type { CartLine, Discounts } from "./types.ts";

/**
 * Итог корзины в центах. Процент акции — только на товары с `promo`, округляется до цента.
 * Купон вычитается последним; итог не бывает меньше нуля.
 */
export function cartTotal(lines: readonly CartLine[], discounts: Discounts = {}): number {
  const subtotal = lines.reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
  const promoBase = lines.filter((line) => line.product.promo).reduce((sum, line) => sum + line.product.priceCents * line.quantity, 0);
  const promoDiscount = Math.round((promoBase * (discounts.promoPercent ?? 0)) / 100);
  return Math.max(0, subtotal - promoDiscount - (discounts.couponCents ?? 0));
}
