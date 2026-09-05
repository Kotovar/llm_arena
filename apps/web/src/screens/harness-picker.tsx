import { type Harness, toggleHarness } from "../ui.js";

/**
 * Среда локальной модели. Галочки, а не радиокнопки: отмеченных больше одной — тот же промпт
 * прогоняется по каждой обвязке подряд, и это единственный способ сравнить обвязки честно.
 *
 * `value` приходит уже нормализованным (`usableHarnesses`): недоступная обвязка не должна
 * оставаться в состоянии, иначе следующая галочка допишется к невидимой первой.
 */
export function HarnessPicker({ value, onChange, available, bareLabel, note }: {
  value: Harness[];
  onChange: (next: Harness[]) => void;
  available: Record<Harness, boolean>;
  /** Подпись голого запуска; её отсутствие означает, что в этом режиме такой обвязки нет. */
  bareLabel?: string | undefined;
  note?: string | undefined;
}) {
  const toggle = (harness: Harness) => (checked: boolean) => onChange(toggleHarness(value, harness, checked));
  return <fieldset className="result-mode">
    <legend>Среда локальной модели</legend>
    <label><input type="checkbox" checked={value.includes("omp")} onChange={(event) => toggle("omp")(event.currentTarget.checked)} disabled={!available.omp} />OMP-среда</label>
    {/* Вторая точка оси: тот же промпт и та же модель, но обвязки почти нет. */}
    <label><input type="checkbox" checked={value.includes("pi")} onChange={(event) => toggle("pi")(event.currentTarget.checked)} disabled={!available.pi} />pi-среда</label>
    {/* Голая модель есть только в текстовом режиме: там это llama-chat без агента и инструментов.
        В web «без обвязки» было тем же OMP с выключенными расширениями — это уже закрывает pi. */}
    {bareLabel ? <label><input type="checkbox" checked={value.includes("bare")} onChange={(event) => toggle("bare")(event.currentTarget.checked)} disabled={!available.bare} />{bareLabel}</label> : null}
    {note ? <small>{note}</small> : null}
  </fieldset>;
}
