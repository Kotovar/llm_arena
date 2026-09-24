import { createSearchBox } from "./search.ts";

const DELAY = 400;
const TYPING_GAP = 80;

type Sent = { query: string; afterMs: number };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Журнал отправленных запросов: что ушло и сколько прошло после последнего нажатия. */
function createLog(list: HTMLElement, summary: HTMLElement) {
  let sent: Sent[] = [];
  let lastKey = performance.now();
  const render = () => {
    list.replaceChildren(...sent.map((item) => {
      const row = document.createElement("li");
      row.textContent = `«${item.query}» — через ${item.afterMs} мс после последнего нажатия`;
      return row;
    }));
    summary.textContent = `Отправлено запросов: ${sent.length}`;
  };
  render();
  return {
    key: () => { lastKey = performance.now(); },
    send: (query: string) => { sent = [...sent, { query, afterMs: Math.round(performance.now() - lastKey) }]; render(); },
    reset: () => { sent = []; render(); },
    count: () => sent.length,
    last: () => sent.at(-1)?.query,
  };
}

/** Набирает текст по букве, как быстрый пользователь. */
async function type(box: { input(text: string): void }, log: { key(): void }, text: string) {
  for (let length = 1; length <= text.length; length += 1) {
    log.key();
    box.input(text.slice(0, length));
    await wait(TYPING_GAP);
  }
}

export function mountDemo(root: HTMLElement) {
  const field = root.querySelector<HTMLInputElement>("#query")!;
  const log = createLog(root.querySelector("#sent")!, root.querySelector("#summary")!);
  const verdict = root.querySelector<HTMLElement>("#verdict")!;
  let box = createSearchBox((query) => log.send(query), DELAY);

  field.addEventListener("input", () => { log.key(); box.input(field.value); });

  const scenario = async (title: string, run: () => Promise<void>, expected: () => boolean, expectation: string) => {
    box.close();
    box = createSearchBox((query) => log.send(query), DELAY);
    field.value = "";
    log.reset();
    verdict.className = "verdict";
    verdict.textContent = `${title}: идёт…`;
    await run();
    await wait(DELAY + 200);
    const ok = expected();
    verdict.className = `verdict ${ok ? "ok" : "bad"}`;
    verdict.textContent = `${title}: ${ok ? "совпадает с ожиданием" : "НЕ совпадает с ожиданием"} — ${expectation}.`;
  };

  root.querySelector("#burst")!.addEventListener("click", () => void scenario(
    "Быстрый набор «debounce»",
    () => type(box, log, "debounce"),
    () => log.count() === 1 && log.last() === "debounce",
    "ровно один запрос «debounce» через ~400 мс после последней буквы",
  ));
  root.querySelector("#cancel")!.addEventListener("click", () => void scenario(
    "Набор и отмена",
    async () => { await type(box, log, "cancel"); box.close(); },
    () => log.count() === 0,
    "ни одного запроса: поле закрыто до конца паузы",
  ));
}
