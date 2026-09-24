// Замороженная копия исходной реализации — эталон поведения для скрытой проверки.
// Своих типов здесь нет намеренно: эталон не должен зависеть от того, что модель сделает с src/.
type Order = any;
type PriceBreakdown = { subtotal: number; discount: number; appliedPromo: string | null; delivery: number; fees: number; total: number };


export function referenceOrderTotal(order: Order): PriceBreakdown {
  if (order.items.length === 0) {
    return { subtotal: 0, discount: 0, appliedPromo: null, delivery: 0, fees: 0, total: 0 };
  }
  let subtotal = 0;
  let books = 0;
  let electronics = 0;
  let units = 0;
  for (let i = 0; i < order.items.length; i++) {
    const item = order.items[i]!;
    subtotal = subtotal + item.priceCents * item.quantity;
    units = units + item.quantity;
    if (item.category === "books") {
      books = books + item.priceCents * item.quantity;
    } else if (item.category === "electronics") {
      electronics = electronics + item.priceCents * item.quantity;
    }
  }
  let discount = 0;
  let promoDiscount = 0;
  let promo: string | null = null;
  let canUsePromo = true;
  if (order.customer.type === "vip") {
    let pct = 10;
    if (order.customer.loyaltyYears > 2) {
      pct = pct + (order.customer.loyaltyYears - 2);
      if (pct > 15) {
        pct = 15;
      }
    }
    discount = Math.round((subtotal * pct) / 100);
  } else if (order.customer.type === "employee") {
    canUsePromo = false;
    if (subtotal - electronics > 0) {
      discount = Math.round(((subtotal - electronics) * 20) / 100);
    }
  } else {
    if (order.customer.loyaltyYears >= 5) {
      discount = Math.round((subtotal * 3) / 100);
    }
  }
  if (order.promoCode && canUsePromo) {
    const code = order.promoCode.trim().toUpperCase();
    if (code === "SAVE10") {
      if (subtotal >= 5000) {
        promoDiscount = Math.round(((subtotal - discount) * 10) / 100);
        promo = code;
      }
    } else if (code === "FLAT5") {
      if (subtotal - discount >= 2000) {
        promoDiscount = 500;
        promo = code;
      }
    } else if (code === "BOOKS20") {
      if (books > 0) {
        promoDiscount = Math.round((books * 20) / 100);
        promo = code;
      }
    }
  }
  discount = discount + promoDiscount;
  if (discount > Math.round((subtotal * 30) / 100)) {
    discount = Math.round((subtotal * 30) / 100);
  }
  let delivery = 0;
  if (order.delivery === "standard") {
    if (subtotal - discount >= 7500) {
      delivery = 0;
    } else {
      delivery = 499;
    }
  } else if (order.delivery === "express") {
    if (order.customer.type === "vip") {
      delivery = 799;
    } else {
      delivery = 1299;
    }
  }
  let fees = 0;
  if (order.giftWrap) {
    fees = fees + units * 150;
    if (fees > 1000) {
      fees = 1000;
    }
  }
  if (order.delivery !== "pickup" && subtotal - discount < 1500) {
    fees = fees + 300;
  }
  const total = subtotal - discount + delivery + fees;
  return { subtotal: subtotal, discount: discount, appliedPromo: promo, delivery: delivery, fees: fees, total: total };
}
