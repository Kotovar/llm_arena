import { deepEqual, equal } from "node:assert/strict";
import { beforeEach, test, type TestContext } from "node:test";
import { debounce } from "./src/debounce.ts";

let calls: unknown[][];
let contexts: unknown[];

function record(this: unknown, ...args: unknown[]) {
  contexts.push(this);
  calls.push(args);
}

function useTimers(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return (ms: number) => t.mock.timers.tick(ms);
}

beforeEach(() => {
  calls = [];
  contexts = [];
});

test("серия быстрых вызовов даёт один вызов с последними аргументами", (t) => {
  const tick = useTimers(t);
  const debounced = debounce(record, 100);

  debounced("a");
  tick(30);
  debounced("b");
  tick(30);
  debounced("c");
  tick(100);

  deepEqual(calls, [["c"]]);
});

test("не вызывает функцию раньше срока", (t) => {
  const tick = useTimers(t);
  const debounced = debounce(record, 100);

  debounced();
  equal(calls.length, 0);
  tick(99);
  equal(calls.length, 0);
  tick(1);
  equal(calls.length, 1);
});

test("каждый вызов перезапускает ожидание", (t) => {
  const tick = useTimers(t);
  const debounced = debounce(record, 100);

  debounced(1);
  tick(60);
  debounced(2);
  tick(60);
  equal(calls.length, 0);
  tick(40);
  deepEqual(calls, [[2]]);
});

test("передаёт все аргументы как есть", (t) => {
  const tick = useTimers(t);
  const debounced = debounce(record, 50);
  const payload = { id: 7 };

  debounced(1, "two", payload, undefined);
  tick(50);

  deepEqual(calls, [[1, "two", payload, undefined]]);
  equal(calls[0]![2], payload);
});

test("сохраняет this последнего вызова", (t) => {
  const tick = useTimers(t);
  const first = { name: "first", save: debounce(record, 50) };
  const second = { name: "second", save: first.save };

  first.save();
  second.save();
  tick(50);

  equal(contexts.length, 1);
  equal(contexts[0], second);
});

test("cancel отменяет запланированный вызов", (t) => {
  const tick = useTimers(t);
  const debounced = debounce(record, 100);

  debounced("x");
  tick(50);
  debounced.cancel();
  tick(500);

  deepEqual(calls, []);
});

test("после cancel функцией можно пользоваться снова", (t) => {
  const tick = useTimers(t);
  const debounced = debounce(record, 100);

  debounced("old");
  debounced.cancel();
  debounced("new");
  tick(100);

  deepEqual(calls, [["new"]]);
});

test("cancel без ожидающего вызова ничего не ломает", (t) => {
  const tick = useTimers(t);
  const debounced = debounce(record, 100);

  debounced.cancel();
  debounced("after");
  tick(100);
  debounced.cancel();
  tick(100);

  deepEqual(calls, [["after"]]);
});

test("разделённые паузой серии дают по вызову на каждую", (t) => {
  const tick = useTimers(t);
  const debounced = debounce(record, 100);

  debounced("first");
  tick(100);
  debounced("second");
  tick(100);

  deepEqual(calls, [["first"], ["second"]]);
});

test("разные debounce-функции не делят таймер", (t) => {
  const tick = useTimers(t);
  const left = debounce(record, 100);
  const right = debounce(record, 100);

  left("left");
  right("right");
  left.cancel();
  tick(100);

  deepEqual(calls, [["right"]]);
});
