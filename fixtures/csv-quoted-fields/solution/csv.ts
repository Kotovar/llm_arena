/**
 * Разбирает CSV в строки полей.
 *
 * Формат:
 * - поля разделяются запятой, строки — `\n` или `\r\n`;
 * - поле можно взять в двойные кавычки; внутри кавычек запятая и перевод строки — часть
 *   значения, а две кавычки подряд (`""`) означают одну кавычку;
 * - пустые строки пропускаются, поэтому перевод строки в конце файла лишней записи не даёт.
 *
 * Пробелы вокруг полей не обрезаются: это решает вызывающий код.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Строка из одного пустого поля без кавычек — пустая строка файла, её пропускаем.
  let rowHadQuotes = false;

  const endRow = () => {
    row.push(field);
    if (row.length > 1 || field !== "" || rowHadQuotes) rows.push(row);
    row = [];
    field = "";
    rowHadQuotes = false;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
    } else if (char === '"' && field === "") {
      inQuotes = true;
      rowHadQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      endRow();
    } else if (char === "\r" && text[i + 1] === "\n") {
      endRow();
      i++;
    } else {
      field += char;
    }
  }
  if (row.length > 0 || field !== "" || rowHadQuotes) endRow();
  return rows;
}
