import { debounce } from "./debounce.ts";

/** Приводит запрос к виду, в котором его ждёт поиск: без лишних пробелов и регистра. */
export function normalizeQuery(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Поле поиска: отправляет запрос, когда пользователь перестал печатать. */
export function createSearchBox(search: (query: string) => void, delay = 300) {
  const send = debounce((query: string) => search(query), delay);
  return {
    input(text: string) {
      const query = normalizeQuery(text);
      if (query) send(query);
      else send.cancel();
    },
    close() {
      send.cancel();
    },
  };
}
