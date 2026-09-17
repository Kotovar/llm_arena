/** Дефолт llama-server (0.8) на длинном контексте срывает tool call, поэтому арена держит свой. */
export const DEFAULT_LLAMA_TEMPERATURE = 0.2;

/** Промпт с этим тегом принадлежит бенчмарку: его условия заточены под прогон набора, обычному запуску он не отдаётся. */
export const BENCHMARK_TAG = "benchmark";
