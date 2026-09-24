import { deepEqual } from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "./src/csv.ts";
import { importContacts } from "./src/contacts.ts";

// Данные намеренно не совпадают с contacts.csv из проекта: хардкод примера не пройдёт.

test("запятая внутри кавычек не делит поле", () => {
  deepEqual(parseCsv('id,title\n7,"Paris, France"\n8,"a,b,,c"'), [
    ["id", "title"],
    ["7", "Paris, France"],
    ["8", "a,b,,c"],
  ]);
});

test("две кавычки внутри кавычек — одна кавычка", () => {
  deepEqual(parseCsv('"say ""hi""",x\n"""",""""""\n"end"""'), [
    ['say "hi"', "x"],
    ['"', '""'],
    ['end"'],
  ]);
});

test("перевод строки внутри кавычек — часть значения", () => {
  deepEqual(parseCsv('k,v\n1,"line one\nline two"\n2,"crlf\r\nkept"\r\n3,"\n\n"\n'), [
    ["k", "v"],
    ["1", "line one\nline two"],
    ["2", "crlf\r\nkept"],
    ["3", "\n\n"],
  ]);
});

test("пустое поле в кавычках — пустая строка", () => {
  deepEqual(parseCsv('a,"",c\n"","",""\n"",tail'), [
    ["a", "", "c"],
    ["", "", ""],
    ["", "tail"],
  ]);
});

test("всё вместе в одной строке и на границах", () => {
  deepEqual(parseCsv('"x, ""y""\nz",,""\r\n\r\nlast,"q"'), [
    ['x, "y"\nz', "", ""],
    ["last", "q"],
  ]);
});

test("простые случаи по-прежнему работают", () => {
  deepEqual(parseCsv("a,b\r\n\r\n1,,3\n"), [["a", "b"], ["1", "", "3"]]);
  deepEqual(parseCsv(""), []);
});

test("импорт контактов: кавычки доходят до потребителя", () => {
  const csv = [
    "notes,email,name,phone",
    '"Board member, since 2019",IVAN.K@example.org,"Kuznetsov, Ivan",""',
    '"Called ""urgent""\ntwice",zoe@example.org,Zoe,"+1 555, ext. 9"',
    '"",noah@example.org,"Noah ""Nat"" Brooks",',
  ].join("\n") + "\n";
  deepEqual(importContacts(csv), [
    { name: "Kuznetsov, Ivan", email: "ivan.k@example.org", phone: "", notes: "Board member, since 2019" },
    { name: "Zoe", email: "zoe@example.org", phone: "+1 555, ext. 9", notes: 'Called "urgent"\ntwice' },
    { name: 'Noah "Nat" Brooks', email: "noah@example.org", phone: "", notes: "" },
  ]);
});
