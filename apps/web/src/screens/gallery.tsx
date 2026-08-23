import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Panel, useData } from "../shell.js";
import type { GalleryMetrics, GalleryResult, ResultVersion } from "../types.js";
import { formatDuration, formatMetricValue, galleryMatrix, galleryResultTags, plural } from "../ui.js";
import { usePreviewHeartbeat } from "./results.js";

type PreviewState = { taskRunId: string; resultSha: string; url: string };

function stopPreview(preview: PreviewState) {
  return api("/preview", { method: "DELETE", body: JSON.stringify({ taskRunId: preview.taskRunId, resultSha: preview.resultSha }) });
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
    <span className="gallery-result-copy"><strong>{versionLabel(result.selectedVersion)}</strong><small>Запуск {result.runId.slice(0, 8)}</small>{tags.length ? <small title={tags.join(" · ")}>{tags.join(" · ")}</small> : null}</span>
    <ResultMetrics metrics={result.metrics} compact />
  </button>;
}

function GalleryCell({ results, onOpen }: { results: GalleryResult[]; onOpen: (result: GalleryResult) => void }) {
  if (!results.length) return <span className="gallery-empty">Нет результата</span>;
  if (results.length === 1) return <GalleryResultButton result={results[0]!} onOpen={onOpen} />;
  return <details className="gallery-multiple"><summary><strong>{results.length} {plural(results.length, "результат", "результата", "результатов")}</strong><span>Выберите запуск</span></summary><div>{results.map((result) => <GalleryResultButton key={result.taskRunId} result={result} onOpen={onOpen} />)}</div></details>;
}

function GalleryDetail({ result, onClose }: { result: GalleryResult; onClose: () => void }) {
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
  usePreviewHeartbeat(Boolean(preview));
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
    <header><div><span className="mono">{versionLabel(result.selectedVersion)}</span><h2>{result.prompt.name}</h2></div><button type="button" aria-label="Закрыть подробности результата" onClick={() => dialog.current?.close()}>Закрыть</button></header>
    <div className="gallery-detail-grid"><section><Screenshot result={result} className="gallery-detail-shot" />{preview ? <section className="result-preview"><header><div><span className="mono">Preview запущен</span><strong>Версия по SHA</strong></div><div><a href={preview.url} target="_blank" rel="noreferrer">Открыть в новой вкладке ↗</a><button type="button" onClick={() => stop.mutate()} disabled={stop.isPending}>Остановить preview</button></div></header><iframe title={`Preview ${result.prompt.name}`} src={preview.url} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock" /></section> : <section className="preview-cta"><div><span className="mono">Готовая версия</span><strong>Запустить web-приложение</strong><p>Preview материализует выбранный SHA и заменит текущий единственный preview.</p></div><button type="button" className="primary" onClick={() => start.mutate()} disabled={start.isPending}>{start.isPending ? "Запускаем…" : "Запустить preview →"}</button></section>}{start.error || stop.error ? <p className="error">{(start.error ?? stop.error)?.message}</p> : null}</section>
      <aside className="gallery-details"><dl><div><dt>Модель</dt><dd>{result.model.name}</dd></div><div><dt>Версия</dt><dd>{versionLabel(result.selectedVersion)}</dd></div><div><dt>SHA</dt><dd><code title={result.selectedVersion.resultSha}>{result.selectedVersion.resultSha.slice(0, 12)}</code></dd></div>{galleryResultTags(result).map((tag) => <div key={tag}><dt>Запуск</dt><dd>{tag}</dd></div>)}</dl><ResultMetrics metrics={result.metrics} /><details><summary>Исходный промпт</summary><pre>{result.prompt.prompt}</pre></details><Link to="/runs/$runId" params={{ runId: result.runId }}>Открыть полный результат запуска →</Link></aside>
    </div>
  </dialog>;
}

export function GalleryPage() {
  const gallery = useData<GalleryResult[]>("gallery", "/gallery");
  const [opened, setOpened] = useState<GalleryResult>();
  const matrix = galleryMatrix(gallery.data ?? []);
  return <div className="gallery-page"><Page title="Галерея" eyebrow="Сравнение" intro="Выбранные итоговые версии web-результатов. Каждая ячейка привязана к её result SHA; preview не запускаются автоматически.">
    {gallery.isPending ? <Empty>Загружаем выбранные результаты…</Empty> : null}
    {gallery.error ? <p className="error">{gallery.error.message}</p> : null}
    {!gallery.isPending && !gallery.error && !gallery.data?.length ? <Empty>Пока нет успешных web-результатов с выбранной версией. Запустите web-задачу и выберите итоговую версию на странице результата.</Empty> : null}
    {matrix.rows.length ? <Panel title="Матрица результатов" action={<span className="mono">{matrix.rows.length} × {matrix.models.length}</span>}><div className="gallery-scroll"><table className="gallery-table"><thead><tr><th scope="col">Промпт</th>{matrix.models.map((model) => <th scope="col" key={model.id}>{model.name}</th>)}</tr></thead><tbody>{matrix.rows.map((row) => <tr key={row.prompt.id}><th scope="row" className="gallery-prompt"><strong>{row.prompt.name}</strong><small>{row.prompt.prompt}</small></th>{row.cells.map((cell) => <td key={cell.model.id}><GalleryCell results={cell.results} onOpen={setOpened} /></td>)}</tr>)}</tbody></table></div></Panel> : null}
    {opened ? <GalleryDetail key={`${opened.taskRunId}:${opened.selectedVersion.resultSha}`} result={opened} onClose={() => setOpened(undefined)} /> : null}
  </Page></div>;
}
