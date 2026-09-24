export type CustomerType = "regular" | "vip" | "employee";
export type Delivery = "pickup" | "standard" | "express";
export type Category = "food" | "electronics" | "books";

/** Все суммы — в центах, целыми числами. */
export interface OrderItem {
  sku: string;
  category: Category;
  priceCents: number;
  quantity: number;
}

export interface Order {
  customer: { type: CustomerType; loyaltyYears: number };
  items: OrderItem[];
  delivery: Delivery;
  promoCode?: string;
  giftWrap?: boolean;
}

export interface PriceBreakdown {
  subtotal: number;
  discount: number;
  appliedPromo: string | null;
  delivery: number;
  fees: number;
  total: number;
}
