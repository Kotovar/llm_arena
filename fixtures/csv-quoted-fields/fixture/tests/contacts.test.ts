import { deepEqual, equal, throws } from "node:assert/strict";
import { test } from "node:test";
import { describeContact, importContacts } from "../src/contacts.ts";

test("находит столбцы по заголовку в любом порядке", () => {
  deepEqual(importContacts("email,name\nann@example.com,Ann"), [
    { name: "Ann", email: "ann@example.com", phone: "", notes: "" },
  ]);
});

test("обрезает значения и приводит email к нижнему регистру", () => {
  deepEqual(importContacts("Name , Email,phone\n  Bob ,  BOB@Example.com , 123 "), [
    { name: "Bob", email: "bob@example.com", phone: "123", notes: "" },
  ]);
});

test("пропускает строки без email", () => {
  const contacts = importContacts("name,email\nNo Mail,\nYes,yes@example.com");
  deepEqual(contacts.map((contact) => contact.name), ["Yes"]);
});

test("требует обязательные столбцы", () => {
  throws(() => importContacts("name,phone\nAnn,1"), /Missing column: email/);
});

test("пустой файл — нет контактов", () => {
  deepEqual(importContacts(""), []);
});

test("сводка контакта", () => {
  equal(describeContact({ name: "Ann", email: "a@x.io", phone: "1", notes: "" }), "Ann <a@x.io> · 1");
});
