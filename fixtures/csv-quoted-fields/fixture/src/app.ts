import { importContacts } from "./contacts.ts";
import { parseCsv } from "./csv.ts";

/** Перевод строки внутри значения показываем знаком, иначе его не отличить от конца записи. */
const visible = (value: string) => value.replaceAll("\r", "").replaceAll("\n", " ↵ ");

function fieldCount(count: number) {
  const ones = count % 10;
  const tens = count % 100;
  const word = tens >= 11 && tens <= 14 ? "полей" : ones === 1 ? "поле" : ones >= 2 && ones <= 4 ? "поля" : "полей";
  return `${count} ${word}`;
}

function cell(tag: "td" | "th", text: string, className = "") {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function renderRows(target: HTMLElement, rows: string[][]) {
  const width = rows[0]?.length ?? 0;
  target.replaceChildren(...rows.map((row, index) => {
    const line = document.createElement("tr");
    line.className = row.length === width ? "" : "wrong";
    line.append(cell("th", String(index)), ...row.map((value) => cell("td", visible(value), value === "" ? "empty" : "")), cell("td", fieldCount(row.length), "meta"));
    return line;
  }));
}

function renderContacts(target: HTMLElement, text: string) {
  try {
    const contacts = importContacts(text);
    target.replaceChildren(...contacts.map((contact) => {
      const line = document.createElement("tr");
      line.append(cell("td", contact.name), cell("td", contact.email), cell("td", contact.phone, contact.phone ? "" : "empty"), cell("td", visible(contact.notes), contact.notes ? "" : "empty"));
      return line;
    }));
  } catch (error) {
    const line = document.createElement("tr");
    line.append(cell("td", (error as Error).message, "wrong"));
    target.replaceChildren(line);
  }
}

export async function mountDemo(root: HTMLElement) {
  const input = root.querySelector<HTMLTextAreaElement>("#csv")!;
  const rows = root.querySelector<HTMLElement>("#rows")!;
  const contacts = root.querySelector<HTMLElement>("#contacts")!;
  const render = () => {
    renderRows(rows, parseCsv(input.value));
    renderContacts(contacts, input.value);
  };
  input.value = await (await fetch("contacts.csv")).text();
  input.addEventListener("input", render);
  render();
}
