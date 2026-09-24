import type { CartLine, Product } from "./types.ts";

export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 10;

export class CartError extends Error {
  override name = "CartError";
}

function checkQuantity(quantity: number) {
  if (!Number.isInteger(quantity) || quantity < MIN_QUANTITY) {
    throw new CartError(`Quantity must be at least ${MIN_QUANTITY}`);
  }
  if (quantity > MAX_QUANTITY) {
    throw new CartError(`Quantity must not exceed ${MAX_QUANTITY}`);
  }
}

/** Корзина: по позиции на товар, количество позиции — от 1 до 10. */
export class Cart {
  #lines: CartLine[] = [];

  /** Добавляет товар; если он уже в корзине — увеличивает количество. */
  add(product: Product, quantity = 1): void {
    const line = this.#lines.find((item) => item.product.id === product.id);
    checkQuantity(quantity);
    checkQuantity((line?.quantity ?? 0) + quantity);
    if (line) line.quantity += quantity;
    else this.#lines.push({ product, quantity });
  }

  setQuantity(productId: string, quantity: number): void {
    checkQuantity(quantity);
    const line = this.#find(productId);
    line.quantity = quantity;
  }

  /** Убирает одну единицу товара; последняя единица убирает позицию целиком. */
  removeOne(productId: string): void {
    const line = this.#find(productId);
    if (line.quantity > 1) {
      line.quantity -= 1;
      return;
    }
    this.#lines.splice(this.#lines.indexOf(line), 1);
  }

  remove(productId: string): void {
    this.#lines.splice(this.#lines.indexOf(this.#find(productId)), 1);
  }

  quantityOf(productId: string): number {
    return this.#lines.find((item) => item.product.id === productId)?.quantity ?? 0;
  }

  lines(): CartLine[] {
    return this.#lines.map((line) => ({ product: line.product, quantity: line.quantity }));
  }

  #find(productId: string): CartLine {
    const line = this.#lines.find((item) => item.product.id === productId);
    if (!line) throw new CartError(`Product ${productId} is not in the cart`);
    return line;
  }
}
