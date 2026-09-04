import { Link } from "@tanstack/react-router";
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useHotkey } from "../shell.js";
import type { Task } from "../types.js";
import { galleryCoverage, matchesPromptQuery, promptCoverageNote, updateTaskSelection } from "../ui.js";

/**
 * Выбор промптов: один и тот же блок нужен и одиночному запуску, и массовому.
 * Покрытие показывается только там, где модель одна, — в батче их несколько.
 */
export function PromptPicker({ tasks, selectedIds, setSelectedIds, coverage, modelId = "" }: {
  tasks: Task[] | undefined;
  selectedIds: string[] | null;
  setSelectedIds: Dispatch<SetStateAction<string[] | null>>;
  coverage?: ReturnType<typeof galleryCoverage>;
  modelId?: string;
}) {
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const search = useRef<HTMLInputElement>(null);
  useHotkey("/", () => search.current?.focus());
  const selected = new Set(selectedIds ?? []);
  // Считаем по существующим промптам: в выборе может остаться ревизия убранного в архив промпта.
  const selectedCount = (tasks ?? []).filter((task) => selected.has(task.currentRevision.id)).length;
  // Поиск прячет строки, но не снимает выбор: отфильтрованный промпт всё равно уйдёт в запуск.
  const visibleTasks = (tasks ?? []).filter((task) => matchesPromptQuery(task, query) && (!tag || task.tags.includes(tag)));
  const tags = [...new Set((tasks ?? []).flatMap((task) => task.tags))].sort((left, right) => left.localeCompare(right, "ru"));
  return <fieldset className="prompt-picker">
    <legend><strong>Какие промпты запустить</strong><small>{selectedCount} из {tasks?.length ?? 0}</small></legend>
    <div className="picker-actions"><input ref={search} type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Поиск" title="/" aria-label="Поиск промптов" /><button type="button" onClick={() => setSelectedIds(visibleTasks.map((task) => task.currentRevision.id))}>{tag || query ? "Выбрать показанные" : "Выбрать все"}</button><button type="button" onClick={() => setSelectedIds([])}>Снять все</button><Link to="/tasks">Добавить промпт</Link></div>
    {tags.length ? <div className="prompt-tags" role="group" aria-label="Теги промптов"><button type="button" className={tag ? "" : "active"} aria-pressed={!tag} onClick={() => setTag("")}>Все</button>{tags.map((item) => <button type="button" key={item} className={tag === item ? "active" : ""} aria-pressed={tag === item} onClick={() => setTag(tag === item ? "" : item)}>{item}</button>)}</div> : null}
    <div className="prompt-options">{visibleTasks.map((task) => <label key={task.id} className={selected.has(task.currentRevision.id) ? "selected" : ""}><input type="checkbox" checked={selected.has(task.currentRevision.id)} onChange={(event) => { const checked = event.currentTarget.checked; setSelectedIds((current) => updateTaskSelection(current, task.currentRevision.id, checked)); }} /><span><strong>{task.currentRevision.name}</strong><small title={task.description || task.currentRevision.prompt}>{task.description || task.currentRevision.prompt}</small>{task.tags.length ? <span className="prompt-tag-list">{task.tags.map((item) => <em key={item}>{item}</em>)}</span> : null}</span>{(() => { const note = coverage && promptCoverageNote(coverage, task, modelId); return note ? <em className={`prompt-covered ${note.state}`}>{note.text}</em> : null; })()}</label>)}</div>
    {!tasks?.length ? <p className="empty">Сначала добавьте промпт.</p> : null}
    {tasks?.length && !visibleTasks.length ? <p className="empty">Ничего не нашлось по запросу.</p> : null}
  </fieldset>;
}
