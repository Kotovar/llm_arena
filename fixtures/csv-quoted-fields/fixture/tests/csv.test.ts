import { deepEqual } from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "../src/csv.ts";

test("разбирает строки и поля", () => {
  deepEqual(parseCsv("a,b,c\n1,2,3"), [["a", "b", "c"], ["1", "2", "3"]]);
});

test("понимает CRLF", () => {
  deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
});

test("пропускает пустые строки и перевод строки в конце", () => {
  deepEqual(parseCsv("a,b\n\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

test("сохраняет пустые поля без кавычек", () => {
  deepEqual(parseCsv("a,,c\n,,"), [["a", "", "c"], ["", "", ""]]);
});

test("снимает кавычки с простого поля", () => {
  deepEqual(parseCsv('"a",b'), [["a", "b"]]);
});

test("пустой текст — пустой результат", () => {
  deepEqual(parseCsv(""), []);
});
