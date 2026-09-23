import { readFileSync } from "node:fs";
import { describeContact, importContacts } from "./contacts.ts";

const [file = "contacts.csv"] = process.argv.slice(2);
const contacts = importContacts(readFileSync(file, "utf8"));
for (const contact of contacts) console.log(describeContact(contact));
console.log(`\n${contacts.length} contact(s) imported`);
