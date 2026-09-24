/** Отложенная функция: вызывает исходную, когда вызовы стихли на `delay` мс. */
export type Debounced<A extends unknown[], T = unknown> = ((this: T, ...args: A) => void) & {
  /** Отменяет запланированный вызов, если он есть. */
  cancel(): void;
};

/**
 * Откладывает вызов `fn`, пока вызовы не прекратятся на `delay` мс. Срабатывает последний
 * вызов серии — с его аргументами и его `this`.
 *
 * Временная заглушка: вызывает `fn` сразу, а `cancel` ничего не делает.
 */
export function debounce<A extends unknown[], T = unknown>(fn: (this: T, ...args: A) => void, delay: number): Debounced<A, T> {
  const debounced = function (this: T, ...args: A) {
    fn.apply(this, args);
  } as Debounced<A, T>;
  debounced.cancel = () => {};
  return debounced;
}
