const NAMES = ["Ada", "Alan", "Barbara", "Brian", "Claude", "Donald", "Edsger", "Frances", "Grace", "Guido", "Hedy", "Ivan", "John", "Ken", "Linus", "Margaret", "Niklaus", "Radia", "Richard", "Sophie", "Tim", "Whitfield", "Yukihiro"];
const USERS = NAMES.map((name, index) => ({ id: index + 1, name }));
const PAGE_SIZE = 5;
const LATENCY_MS = 600;
const failedOnce = new Set();

/**
 * Клиент API пользователей. Бэкенда у проекта нет, поэтому он эмулируется: ответ приходит с
 * задержкой, а третья страница с первой попытки не отдаётся — так на странице видно ошибку.
 *
 * @param {{ page: number }} params страницы нумеруются с 1
 * @returns {Promise<{ users: Array<{ id: number, name: string }>, page: number, hasNextPage: boolean }>}
 */
export function getUsers({ page }) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (page === 3 && !failedOnce.has(page)) {
        failedOnce.add(page);
        reject(new Error("Сервер не ответил, попробуйте ещё раз"));
        return;
      }
      const start = (page - 1) * PAGE_SIZE;
      resolve({ users: USERS.slice(start, start + PAGE_SIZE), page, hasNextPage: start + PAGE_SIZE < USERS.length });
    }, LATENCY_MS);
  });
}

export const usersClient = { getUsers };
