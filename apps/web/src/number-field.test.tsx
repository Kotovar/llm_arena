// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it } from "vitest";
import { NumberField } from "./shell.js";

it("шагает своими кнопками с учётом step, min и max", async () => {
  const user = userEvent.setup();
  const { container } = render(<NumberField aria-label="Температура" min={0} max={0.3} step={0.1} defaultValue="0.1" />);
  const field = screen.getByLabelText("Температура") as HTMLInputElement;
  const steps = container.querySelectorAll("button");
  const [up, down] = [steps[0]!, steps[1]!];
  await user.click(up);
  expect(field.value).toBe("0.2");
  await user.click(down);
  await user.click(down);
  expect(field.value).toBe("0");
  await user.click(down);
  expect(field.value).toBe("0");
});

it("не даёт менять поле только для чтения", async () => {
  const user = userEvent.setup();
  const { container } = render(<NumberField aria-label="Контекст" readOnly defaultValue="100000" />);
  await user.click(container.querySelectorAll("button")[0]!);
  expect((screen.getByLabelText("Контекст") as HTMLInputElement).value).toBe("100000");
});

it("сообщает о шаге управляемому полю", async () => {
  const user = userEvent.setup();
  function Controlled() {
    const [value, setValue] = useState("1");
    return <NumberField aria-label="Seed" value={value} onChange={(event) => setValue(event.currentTarget.value)} />;
  }
  const { container } = render(<Controlled />);
  await user.click(container.querySelectorAll("button")[0]!);
  expect((screen.getByLabelText("Seed") as HTMLInputElement).value).toBe("2");
});
