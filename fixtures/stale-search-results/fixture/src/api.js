const DIRECTORY = [
  { id: 1, name: "ada" },
  { id: 2, name: "adam" },
  { id: 3, name: "alan" },
  { id: 4, name: "alice" },
  { id: 5, name: "bo" },
  { id: 6, name: "bob" },
];

/** Эмуляция задержки бэкенда: ходить по сети в этом проекте некуда. */
function latencyFor(query) {
  return Math.max(250, 2050 - query.length * 900);
}

/** @returns {Promise<Array<{ id: number, name: string }>>} */
export function searchUsers(query) {
  const matches = DIRECTORY.filter((user) => user.name.startsWith(query));
  return new Promise((resolve) => setTimeout(() => resolve(matches), latencyFor(query)));
}
