/** Отложенная функция: вызывает исходную, когда вызовы стихли на `delay` мс. */
export type Debounced<A extends unknown[], T = unknown> = ((this: T, ...args: A) => void) & {
  /** Отменяет запланированный вызов, если он есть. */
  cancel(): void;
};

/**
 * Откладывает вызов `fn`, пока вызовы не прекратятся на `delay` мс. Срабатывает последний
 * вызов серии — с его аргументами и его `this`.
 */
export function debounce<A extends unknown[], T = unknown>(fn: (this: T, ...args: A) => void, delay: number): Debounced<A, T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = function (this: T, ...args: A) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn.apply(this, args);
    }, delay);
  } as Debounced<A, T>;
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}
