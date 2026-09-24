import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { resolveOrder } from "../src/resolveOrder.ts";
import { formatSchedule } from "../src/schedule.ts";

test("ставит зависимость перед задачей", () => {
  deepEqual(resolveOrder([
    { id: "a", dependencies: [] },
    { id: "b", dependencies: ["a"] },
  ]), ["a", "b"]);
});

test("сохраняет порядок входа у независимых задач", () => {
  deepEqual(resolveOrder([
    { id: "first", dependencies: [] },
    { id: "second", dependencies: [] },
    { id: "third", dependencies: [] },
  ]), ["first", "second", "third"]);
});

test("печатает план выполнения", () => {
  equal(formatSchedule([{ id: "a", dependencies: [] }, { id: "b", dependencies: ["a"] }]), "1. a\n2. b");
});
