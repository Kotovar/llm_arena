import assert from "node:assert/strict";
import test from "node:test";
import { message } from "./message.js";

test("message is non-empty", () => {
  assert.ok(message());
});
