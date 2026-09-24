import { parseCsv } from "./csv.ts";

export interface Contact {
  name: string;
  email: string;
  phone: string;
  notes: string;
}

const REQUIRED = ["name", "email"] as const;

/**
 * Импортирует контакты из CSV с заголовком. Столбцы ищутся по имени в первой строке, порядок
 * любой; `phone` и `notes` необязательны. Значения обрезаются по краям, email приводится к
 * нижнему регистру, строки без email пропускаются.
 */
export function importContacts(text: string): Contact[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const columns = header.map((name) => name.trim().toLowerCase());
  for (const name of REQUIRED) {
    if (!columns.includes(name)) throw new Error(`Missing column: ${name}`);
  }
  const read = (row: string[], name: string) => {
    const index = columns.indexOf(name);
    return index === -1 ? "" : (row[index] ?? "").trim();
  };

  const contacts: Contact[] = [];
  for (const row of rows) {
    const email = read(row, "email").toLowerCase();
    if (!email) continue;
    contacts.push({ name: read(row, "name"), email, phone: read(row, "phone"), notes: read(row, "notes") });
  }
  return contacts;
}

/** Короткая сводка для вывода в консоль. */
export function describeContact(contact: Contact): string {
  const parts = [`${contact.name} <${contact.email}>`];
  if (contact.phone) parts.push(contact.phone);
  if (contact.notes) parts.push(JSON.stringify(contact.notes));
  return parts.join(" · ");
}
