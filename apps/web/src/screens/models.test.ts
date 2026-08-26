import { describe, expect, it } from "vitest";
import { moveModel } from "./models.js";

describe("moveModel", () => {
  it("places the dragged model before the drop target", () => {
    const models = [{ id: "first" }, { id: "second" }, { id: "third" }];

    expect(moveModel(models, "third", "first").map((model) => model.id)).toEqual(["third", "first", "second"]);
  });
});
