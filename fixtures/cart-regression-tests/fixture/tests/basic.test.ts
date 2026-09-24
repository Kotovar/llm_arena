import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { Cart, cartTotal } from "../src/index.ts";

const tea = { id: "tea", name: "Tea", priceCents: 450 };

test("добавляет товар в корзину", () => {
  const cart = new Cart();
  cart.add(tea, 2);
  deepEqual(cart.lines(), [{ product: tea, quantity: 2 }]);
});

test("считает итог без скидок", () => {
  const cart = new Cart();
  cart.add(tea, 3);
  equal(cartTotal(cart.lines()), 1350);
});

test("удаляет позицию целиком", () => {
  const cart = new Cart();
  cart.add(tea, 3);
  cart.remove("tea");
  deepEqual(cart.lines(), []);
});
