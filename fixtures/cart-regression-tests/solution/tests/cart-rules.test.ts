import { deepEqual, equal, throws } from "node:assert/strict";
import { describe, test } from "node:test";
import { Cart, CartError, cartTotal, type Product } from "../src/index.ts";

const tea: Product = { id: "tea", name: "Tea", priceCents: 450 };
const mug: Product = { id: "mug", name: "Mug", priceCents: 1200, promo: true };
const cake: Product = { id: "cake", name: "Cake", priceCents: 800 };

describe("количество позиции", () => {
  test("не может быть меньше 1", () => {
    const cart = new Cart();
    cart.add(tea, 2);
    throws(() => cart.setQuantity("tea", 0), CartError);
    throws(() => cart.add(mug, 0), CartError);
    equal(cart.quantityOf("tea"), 2);
    equal(cart.quantityOf("mug"), 0);
  });

  test("может быть от 1 до 10 включительно", () => {
    const cart = new Cart();
    cart.add(tea, 10);
    cart.setQuantity("tea", 1);
    equal(cart.quantityOf("tea"), 1);
    cart.setQuantity("tea", 10);
    equal(cart.quantityOf("tea"), 10);
  });

  test("не может превышать 10", () => {
    const cart = new Cart();
    cart.add(tea, 3);
    throws(() => cart.setQuantity("tea", 11), CartError);
    throws(() => cart.add(mug, 11), CartError);
    equal(cart.quantityOf("tea"), 3);
    equal(cart.quantityOf("mug"), 0);
  });

  test("повторное добавление не выводит за 10", () => {
    const cart = new Cart();
    cart.add(tea, 6);
    throws(() => cart.add(tea, 5), CartError);
    equal(cart.quantityOf("tea"), 6);
    cart.add(tea, 4);
    equal(cart.quantityOf("tea"), 10);
  });
});

describe("удаление", () => {
  test("последняя единица убирает позицию целиком", () => {
    const cart = new Cart();
    cart.add(tea, 2);
    cart.removeOne("tea");
    equal(cart.quantityOf("tea"), 1);
    cart.removeOne("tea");
    deepEqual(cart.lines(), []);
  });
});

describe("операции с одним товаром не трогают другие", () => {
  function filled() {
    const cart = new Cart();
    cart.add(tea, 2);
    cart.add(mug, 3);
    cart.add(cake, 4);
    return cart;
  }

  test("изменение количества", () => {
    const cart = filled();
    cart.setQuantity("mug", 7);
    deepEqual(cart.lines().map((line) => [line.product.id, line.quantity]), [["tea", 2], ["mug", 7], ["cake", 4]]);
  });

  test("удаление последней единицы", () => {
    const cart = filled();
    cart.setQuantity("mug", 1);
    cart.removeOne("mug");
    deepEqual(cart.lines().map((line) => [line.product.id, line.quantity]), [["tea", 2], ["cake", 4]]);
  });
});

describe("итог", () => {
  test("скидка акции только на товары акции", () => {
    const cart = new Cart();
    cart.add(tea, 2);
    cart.add(mug, 1);
    equal(cartTotal(cart.lines(), { promoPercent: 50 }), 900 + 600);
  });

  test("не становится отрицательным", () => {
    const cart = new Cart();
    cart.add(tea, 1);
    equal(cartTotal(cart.lines(), { couponCents: 1000 }), 0);
  });
});
