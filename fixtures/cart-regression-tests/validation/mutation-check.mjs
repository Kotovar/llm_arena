// Скрытая проверка качества тестов: тесты модели должны пройти на исходном коде корзины и
// упасть на каждом мутанте — копии исходника с одной правдоподобной регрессией.
// Исходник берётся из original-src/, а не из src/ рабочего каталога: правка production-кода
// не должна подгонять код под тесты.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const original = join(here, "original-src");

/** Каждый мутант — одна замена в одном файле. Строка поиска обязана найтись ровно один раз. */
const mutants = [
  { id: "min-zero", rule: "количество не меньше 1", file: "cart.ts", from: "quantity < MIN_QUANTITY", to: "quantity < 0" },
  { id: "no-max", rule: "количество не больше 10", file: "cart.ts", from: "if (quantity > MAX_QUANTITY) {", to: "if (false) {" },
  { id: "max-eleven", rule: "количество не больше 10 (граница)", file: "cart.ts", from: "if (quantity > MAX_QUANTITY) {", to: "if (quantity > MAX_QUANTITY + 1) {" },
  { id: "add-ignores-existing", rule: "количество не больше 10 при повторном добавлении", file: "cart.ts", from: "checkQuantity((line?.quantity ?? 0) + quantity);", to: "" },
  { id: "last-unit-keeps-line", rule: "последняя единица убирает позицию", file: "cart.ts", from: "if (line.quantity > 1) {", to: "if (line.quantity > 0) {" },
  { id: "promo-for-all", rule: "скидка только на товары акции", file: "pricing.ts", from: "lines.filter((line) => line.product.promo)", to: "lines" },
  { id: "negative-total", rule: "итог не отрицательный", file: "pricing.ts", from: "Math.max(0, subtotal - promoDiscount - (discounts.couponCents ?? 0))", to: "subtotal - promoDiscount - (discounts.couponCents ?? 0)" },
  { id: "set-touches-others", rule: "операция с товаром не трогает другие", file: "cart.ts", from: "    const line = this.#find(productId);\n    line.quantity = quantity;", to: "    this.#find(productId);\n    for (const line of this.#lines) line.quantity = quantity;" },
  { id: "remove-neighbour", rule: "операция с товаром не трогает другие", file: "cart.ts", from: "this.#lines.splice(this.#lines.indexOf(line), 1);", to: "this.#lines.splice(Math.max(0, this.#lines.indexOf(line) - 1), 1);" },
];

/** Копия рабочего каталога с исходником (и, если задан, мутантом) вместо src/. */
function prepare(mutant) {
  const dir = mkdtempSync(join(tmpdir(), "cart-mutant-"));
  for (const entry of readdirSync(process.cwd())) {
    if (entry === "original-src" || entry === "mutation-check.mjs" || entry === "node_modules") continue;
    cpSync(entry, join(dir, entry), { recursive: true });
  }
  rmSync(join(dir, "src"), { recursive: true, force: true });
  cpSync(original, join(dir, "src"), { recursive: true });
  if (mutant) {
    const path = join(dir, "src", mutant.file);
    const source = readFileSync(path, "utf8");
    if (source.split(mutant.from).length !== 2) throw new Error(`Mutant ${mutant.id}: pattern must occur exactly once in ${mutant.file}`);
    writeFileSync(path, source.replace(mutant.from, mutant.to));
  }
  return dir;
}

function runTests(dir) {
  const result = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` };
}

function changedProductionFiles() {
  const changed = [];
  for (const file of readdirSync(original)) {
    let current = null;
    try { current = readFileSync(join("src", file), "utf8"); } catch {}
    if (current !== readFileSync(join(original, file), "utf8")) changed.push(file);
  }
  return changed;
}

const changed = changedProductionFiles();
if (changed.length) console.log(`Production-код изменён моделью: ${changed.join(", ")}. Проверка идёт по исходнику.\n`);

const base = prepare(null);
const baseline = runTests(base);
rmSync(base, { recursive: true, force: true });
if (!baseline.ok) {
  console.log("Тесты падают на исходном, корректном коде корзины — мутанты не проверяются.\n");
  console.log(baseline.output);
  process.exit(1);
}
console.log("Исходный код: тесты проходят.\n");

let caught = 0;
for (const mutant of mutants) {
  const dir = prepare(mutant);
  const { ok } = runTests(dir);
  rmSync(dir, { recursive: true, force: true });
  if (!ok) caught += 1;
  console.log(`${ok ? "✗ пропущен" : "✓ пойман "}  ${mutant.id.padEnd(22)} ${mutant.rule}`);
}
console.log(`\nMutations caught: ${caught} / ${mutants.length}`);
process.exit(caught === mutants.length ? 0 : 1);
