/** Цены — в центах, целыми числами. */
export interface Product {
  id: string;
  name: string;
  priceCents: number;
  /** Участвует в текущей акции. */
  promo?: boolean;
}

export interface CartLine {
  product: Product;
  quantity: number;
}

export interface Discounts {
  /** Скидка в процентах на товары, участвующие в акции. */
  promoPercent?: number;
  /** Купон на фиксированную сумму со всей корзины. */
  couponCents?: number;
}
