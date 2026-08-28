import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Panel, useData } from "../shell.js";
import type { GalleryMetrics, GalleryResult, ResultVersion } from "../types.js";
import { formatDuration, formatMetricValue, galleryMatrix, galleryResultTags, measurementConditions, plural } from "../ui.js";
import { ResultPreview } from "./results.js";

type PreviewState = { taskRunId: string; resultSha: string; url: string };

function stopPreview(preview: PreviewState) {
  return api("/preview", { method: "DELETE", body: JSON.stringify({ taskRunId: preview.taskRunId, resultSha: preview.resultSha }) });
}

function detailRows(result: GalleryResult) {
  const rows: [string, string][] = [["Модель", result.model.name], ["Версия", versionLabel(result.selectedVersion)]];
  if (result.reviewScore != null) rows.push(["Моя оценка", `${result.reviewScore}/${result.reviewPossible ?? 40}`]);
  const conditions = result.profile ? measurementConditions({ name: result.profile.name, parameters: { context: result.profile.context } }) : undefined;
  if (conditions) rows.push(["Условия замера", conditions]);
  for (const tag of galleryResultTags(result)) {
    if (tag.startsWith("мышление: ")) rows.push(["Мышление", tag.slice("мышление: ".length)]);
    else rows.push([result.model.kind === "local-gguf" ? "Среда" : "Модель в CLI", tag]);
  }
  return rows;
}

function versionLabel(version: ResultVersion) {
  return version.type === "initial" ? "Исходная версия" : `Уточнение ${version.index}`;
}

function ResultMetrics({ metrics, compact = false }: { metrics: GalleryMetrics | undefined; compact?: boolean }) {
  const items = [
    metrics?.durationMs === undefined ? undefined : { label: "Время", value: formatDuration(metrics.durationMs) },
    metrics?.inputTokens === undefined ? undefined : { label: "Вход", value: formatMetricValue("inputTokens", metrics.inputTokens) },
    metrics?.outputTokens === undefined ? undefined : { label: "Выход", value: formatMetricValue("outputTokens", metrics.outputTokens) },
    metrics?.tokensPerSecond === undefined ? undefined : { label: "Скорость", value: formatMetricValue("generationTokensPerSecond", metrics.tokensPerSecond) },
  ].filter((item): item is { label: string; value: string } => Boolean(item));
  const visible = compact ? items.filter((item) => item.label !== "Вход") : items;
  if (!visible.length) return null;
  return <dl className={compact ? "gallery-metrics compact" : "gallery-metrics"}>{visible.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}

function Screenshot({ result, className }: { result: GalleryResult; className: string }) {
  const [missing, setMissing] = useState(false);
  if (!result.screenshotUrl || missing) return <div className={`${className} gallery-shot-missing`}>Снимок недоступен</div>;
  return <img className={className} src={result.screenshotUrl} alt={`Снимок: ${result.prompt.name}, ${result.model.name}`} loading="lazy" onError={() => setMissing(true)} />;
}

function GalleryResultButton({ result, onOpen }: { result: GalleryResult; onOpen: (result: GalleryResult) => void }) {
  const tags = galleryResultTags(result);
  return <button type="button" className="gallery-result" onClick={() => onOpen(result)}>
    <Screenshot result={result} className="gallery-shot" />
    <span className="gallery-result-copy"><strong>{versionLabel(result.selectedVersion)}{result.reviewScore != null ? <span className="gallery-score">{result.reviewScore}/{result.reviewPossible ?? 40}</span> : null}</strong>{tags.length ? <small title={tags.join(" · ")}>{tags.join(" · ")}</small> : null}</span>
    <ResultMetrics metrics={result.metrics} compact />
  </button>;
}

function GalleryCell({ results, onOpen }: { results: GalleryResult[]; onOpen: (result: GalleryResult) => void }) {
  if (!results.length) return <span className="gallery-empty">Нет результата</span>;
  const [featured, ...alternatives] = results;
  return <div className="gallery-cell"><GalleryResultButton result={featured!} onOpen={onOpen} />{alternatives.length ? <details className="gallery-multiple"><summary><strong>Ещё {alternatives.length} {plural(alternatives.length, "результат", "результата", "результатов")}</strong><span>Выберите запуск</span></summary><div>{alternatives.map((result) => <GalleryResultButton key={result.taskRunId} result={result} onOpen={onOpen} />)}</div></details> : null}</div>;
}

function GalleryDetail({ result, onClose }: { result: GalleryResult; onClose: () => void }) {
  const client = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const activePreview = useRef<PreviewState | undefined>(undefined);
  const closed = useRef(false);
  const [preview, setPreview] = useState<PreviewState>();
  const start = useMutation({
    mutationFn: () => api<PreviewState>(`/task-runs/${result.taskRunId}/preview`, { method: "POST", body: JSON.stringify({ resultSha: result.selectedVersion.resultSha }) }),
    onSuccess: (next) => {
      if (closed.current) { void stopPreview(next); return; }
      activePreview.current = next;
      setPreview(next);
    },
  });
  const stop = useMutation({
    mutationFn: () => activePreview.current ? stopPreview(activePreview.current) : Promise.resolve(),
    onSuccess: () => { activePreview.current = undefined; setPreview(undefined); },
  });
  const feature = useMutation({
    mutationFn: () => api("/gallery/featured", { method: "PUT", body: JSON.stringify({ taskRunId: result.taskRunId }) }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["gallery"] }); onClose(); },
  });
  useEffect(() => {
    closed.current = false;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    return () => {
      closed.current = true;
      const active = activePreview.current;
      activePreview.current = undefined;
      if (active) void stopPreview(active);
    };
  }, []);
  return <dialog className="gallery-dialog" ref={dialog} onClose={onClose} onCancel={(event) => { event.preventDefault(); dialog.current?.close(); }}>
    <header><div><span className="mono">{versionLabel(result.selectedVersion)}</span><h2>{result.prompt.name}</h2>{result.prompt.description ? <p className="task-description">{result.prompt.description}</p> : null}</div><button type="button" className="dialog-close" aria-label="Закрыть подробности результата" onClick={() => dialog.current?.close()}>✕</button></header>
    <div className="gallery-detail-grid"><section><Screenshot result={result} className="gallery-detail-shot" />{preview ? <ResultPreview url={preview.url} target={preview} onClose={() => stop.mutate()} closing={stop.isPending} title="Версия по SHA" /> : <section className="preview-cta"><div><span className="mono">Готовая версия</span><strong>Запустить web-приложение</strong><p>Preview соберёт эту версию и заменит текущий запущенный preview.</p></div><button type="button" className="primary" onClick={() => start.mutate()} disabled={start.isPending}>{start.isPending ? "Запускаем…" : "Запустить preview"}<span>→</span></button></section>}{start.error || stop.error ? <p className="error">{(start.error ?? stop.error)?.message}</p> : null}</section>
      <aside className="gallery-details"><dl>{detailRows(result).map(([label, value]) => <div key={`${label}:${value}`}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{result.featured ? <span className="best-flag">Главный в галерее</span> : <button type="button" onClick={() => feature.mutate()} disabled={feature.isPending}>{feature.isPending ? "Сохраняем…" : "Сделать главным в галерее"}</button>}{feature.error ? <p className="error">{feature.error.message}</p> : null}<ResultMetrics metrics={result.metrics} /><details className="final-prompt"><summary>Итоговый промпт</summary><pre>{result.prompt.prompt}</pre>{result.followupPrompts?.map((prompt, index) => <div key={index}><strong>Уточнение {index + 1}</strong><pre>{prompt}</pre></div>)}</details><Link to="/runs/$runId" params={{ runId: result.runId }}>Открыть полный результат запуска →</Link></aside>
    </div>
  </dialog>;
}

export function GalleryPage() {
  const gallery = useData<GalleryResult[]>("gallery", "/gallery");
  const [opened, setOpened] = useState<GalleryResult>();
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const tags = [...new Set((gallery.data ?? []).flatMap((result) => result.prompt.tags ?? []))].sort((left, right) => left.localeCompare(right, "ru"));
  // Промпт без тегов не принадлежит ни одному срезу, поэтому под выбранным фильтром его не показываем.
  const visible = selectedTags.length
    ? (gallery.data ?? []).filter((result) => (result.prompt.tags ?? []).some((tag) => selectedTags.includes(tag)))
    : gallery.data ?? [];
  const toggleTag = (tag: string) => setSelectedTags((current) => current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]);
  const matrix = galleryMatrix(visible);
  return <div className="gallery-page"><Page title="Галерея" eyebrow="Галерея" intro="Итоговые web-результаты.">
    {gallery.isPending ? <Empty>Загружаем выбранные результаты…</Empty> : null}
    {gallery.error ? <p className="error">{gallery.error.message}</p> : null}
    {!gallery.isPending && !gallery.error && !gallery.data?.length ? <Empty>Пока нет успешных web-результатов с выбранной версией. Запустите web-задачу и выберите итоговую версию на странице результата.</Empty> : null}
    {tags.length ? <div className="gallery-tags" role="group" aria-label="Теги промптов">
      <button type="button" className={selectedTags.length ? "" : "active"} aria-pressed={selectedTags.length === 0} onClick={() => setSelectedTags([])}>Все промпты</button>
      {tags.map((tag) => <button type="button" key={tag} className={selectedTags.includes(tag) ? "active" : ""} aria-pressed={selectedTags.includes(tag)} onClick={() => toggleTag(tag)}>{tag}</button>)}
    </div> : null}
    {matrix.rows.length ? <Panel title="Матрица результатов" action={<span className="mono">{matrix.rows.length} × {matrix.prompts.length}</span>}><div className="gallery-scroll"><table className="gallery-table"><thead><tr><th scope="col" className="gallery-model">Модель</th>{matrix.prompts.map((prompt) => <th scope="col" className="gallery-prompt" key={prompt.id} title={prompt.description || prompt.prompt}><strong>{prompt.name}</strong>{prompt.description ? <small className="task-description">{prompt.description}</small> : <small>{prompt.prompt}</small>}</th>)}</tr></thead><tbody>{matrix.rows.map((row) => <tr key={row.model.id}><th scope="row" className="gallery-model">{row.model.name}</th>{row.cells.map((cell) => <td key={cell.prompt.id}><GalleryCell results={cell.results} onOpen={setOpened} /></td>)}</tr>)}</tbody></table></div></Panel> : null}
    {opened ? <GalleryDetail key={`${opened.taskRunId}:${opened.selectedVersion.resultSha}`} result={opened} onClose={() => setOpened(undefined)} /> : null}
  </Page></div>;
}
