import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api.js";
import { ArrowRightIcon } from "../icons.js";
import { Page, Panel, Status, useData, requestNotifications } from "../shell.js";
import type { TaskOutcome } from "@llm-arena/shared";
import type { BatchCreated, BatchProgress, Model, Profile, Runner, Task } from "../types.js";
import { chooseRunner, latestProfiles, outcomeLabels, plural, promptCountLabel } from "../ui.js";
import { PromptPicker } from "./prompt-picker.js";

/** Параметры прогона одной модели в батче: те же, что подобрал бы лаунчер для неё одной. */
function batchModelEntry(model: Model, runners: Runner[], profiles: Profile[], resultMode: "text" | "web") {
  const useOmpAgent = model.kind === "local-gguf" && model.capabilities.toolUse && runners.some((runner) => runner.kind === "omp");
  const runner = chooseRunner(model, [resultMode === "web" ? "coding" : "prompt"], runners, useOmpAgent ? "omp" : "bare");
  if (!runner) return undefined;
  return {
    modelId: model.id,
    executionProfileId: model.kind === "local-gguf" ? latestProfiles(profiles).find((profile) => profile.modelId === model.id)?.id ?? null : null,
    runnerId: runner.id,
    useOmpAgent,
  };
}

function BatchProgressView({ batchId }: { batchId: string }) {
  const batch = useQuery({
    queryKey: ["batch", batchId],
    queryFn: () => api<BatchProgress>(`/batches/${batchId}`),
    refetchInterval: (query) => query.state.data?.finished ? false : 2_000,
  });
  const cancel = useMutation({ mutationFn: () => api(`/batches/${batchId}/cancel`, { method: "POST" }), onSuccess: () => batch.refetch() });
  const navigate = useNavigate();
  const retry = useMutation({
    mutationFn: () => api<BatchCreated>(`/batches/${batchId}/retry-failed`, { method: "POST" }),
    onSuccess: (created) => navigate({ to: "/batch", search: { id: created.batchId } }),
  });
  if (batch.error) return <p className="error">{batch.error.message}</p>;
  if (!batch.data) return <p>Загружаем…</p>;
  const counts = Object.entries(batch.data.counts).filter(([, count]) => count > 0);
  // Web-результаты сравнивает галерея — она и есть матрица модель × промпт; текстовые — /compare
  // попарно, поэтому туда уходят первые два прогона батча.
  const compare = batch.data.resultMode === "web"
    ? <Link to="/gallery" search={{ prompts: batch.data.taskRevisionIds.join(","), models: batch.data.modelIds.join(",") }}>Сравнить в галерее <ArrowRightIcon /></Link>
    : batch.data.models.length > 1
      ? <Link to="/compare" search={{ left: batch.data.models[0]!.runId, right: batch.data.models[1]!.runId }}>Сравнить ответы <ArrowRightIcon /></Link>
      : null;
  return <Panel title={batch.data.title} action={batch.data.finished
    ? compare
    : <button type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Остановить батч</button>}>
    <p className="batch-active">{batch.data.active ? `${batch.data.active.modelName} · ${batch.data.active.taskName}` : batch.data.finished ? "Батч завершён" : "Ждём очередь"}</p>
    {counts.length ? <dl className="batch-counts">{counts.map(([outcome, count]) => <div key={outcome}><dt>{outcomeLabels[outcome as TaskOutcome]}</dt><dd>{count}</dd></div>)}</dl> : null}
    <div className="run-list">{batch.data.models.map((model) => <Link className="run-row" key={model.runId} to="/runs/$runId" params={{ runId: model.runId }}>
      <Status value={model.status} />
      <span className="run-row-copy"><strong>{model.modelName}</strong><small>{model.prompts.length} из {model.planned} {plural(model.planned, "промпт", "промпта", "промптов")}</small></span>
    </Link>)}</div>
    {batch.data.finished ? <div className="batch-footer">
      {/* Повторять нечего, пока ни одна пара не провалилась: кнопка без работы только сбивает с толку. */}
      {batch.data.failedCount ? <button type="button" onClick={() => retry.mutate()} disabled={retry.isPending}>Повторить неудачи ({batch.data.failedCount})</button> : <span />}
      <small>Промптов в батче: {batch.data.promptCount}</small>
    </div> : null}
    {cancel.error ? <p className="error">{cancel.error.message}</p> : null}
    {retry.error ? <p className="error">{retry.error.message}</p> : null}
  </Panel>;
}

export function BatchPage() {
  const { id } = useSearch({ from: "/batch" });
  const tasks = useData<Task[]>("tasks", "/tasks");
  const models = useData<Model[]>("models", "/models");
  const profiles = useData<Profile[]>("profiles", "/profiles");
  const runners = useData<Runner[]>("runners", "/runners");
  const navigate = useNavigate();
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[] | null>([]);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [resultMode, setResultMode] = useState<"text" | "web">("web");
  const chosenModels = (models.data ?? []).filter((model) => modelIds.includes(model.id));
  const entries = chosenModels.map((model) => batchModelEntry(model, runners.data ?? [], profiles.data ?? [], resultMode));
  const unavailable = chosenModels.filter((_, index) => !entries[index]);
  const promptCount = selectedTaskIds?.length ?? 0;
  const launch = useMutation({
    mutationFn: () => api<BatchCreated>("/batches", { method: "POST", body: JSON.stringify({
      taskRevisionIds: selectedTaskIds ?? [],
      models: entries.filter(Boolean),
      resultMode,
    }) }),
    onSuccess: (created) => navigate({ to: "/batch", search: { id: created.batchId } }),
  });
  const canLaunch = promptCount > 0 && chosenModels.length > 0 && !unavailable.length && !launch.isPending;
  if (id) return <Page title="Массовый запуск" eyebrow="Батч"><BatchProgressView batchId={id} /></Page>;
  return <Page title="Массовый запуск" eyebrow="Батч" intro="Один набор промптов на нескольких моделях. Прогоны встают в общую очередь и идут подряд.">
    <section className="launch-card">
      <div className="launch-step" data-ready={chosenModels.length > 0}><span>1</span><fieldset className="prompt-picker"><legend><strong>Какие модели сравнить</strong><small>{chosenModels.length} из {models.data?.length ?? 0}</small></legend><div className="prompt-options">{(models.data ?? []).map((model) => <label key={model.id} className={modelIds.includes(model.id) ? "selected" : ""}><input type="checkbox" checked={modelIds.includes(model.id)} onChange={(event) => { const checked = event.currentTarget.checked; setModelIds((current) => checked ? [...current, model.id] : current.filter((item) => item !== model.id)); }} /><span><strong>{model.name}</strong><small>{model.provider}</small></span></label>)}</div>{!models.data?.length ? <p className="empty">Сначала подключите модель.</p> : null}</fieldset></div>
      <div className="launch-step prompt-step" data-ready={promptCount > 0}><span>2</span><PromptPicker tasks={tasks.data} selectedIds={selectedTaskIds} setSelectedIds={setSelectedTaskIds} /></div>
      <div className="launch-step" data-ready><span>3</span><div className="launch-fields"><fieldset className="result-mode">
        <legend>Что должна вернуть модель</legend>
        <label><input type="radio" name="batchResultMode" checked={resultMode === "web"} onChange={() => setResultMode("web")} />Готовое web-приложение</label>
        <label><input type="radio" name="batchResultMode" checked={resultMode === "text"} onChange={() => setResultMode("text")} />Текстовый ответ</label>
      </fieldset></div></div>
      <div className="launch-footer"><div className="launch-action"><div><strong>{canLaunch || promptCount ? `${promptCountLabel(promptCount)} × ${chosenModels.length} ${plural(chosenModels.length, "модель", "модели", "моделей")} = ${promptCount * chosenModels.length} ${plural(promptCount * chosenModels.length, "запуск", "запуска", "запусков")}` : "Выберите модели и промпты"}</strong><small>{unavailable.length ? `Не запускается: ${unavailable.map((model) => model.name).join(", ")}` : "Прогоны пойдут подряд, по одному на модель"}</small></div><button className="primary launch-button" onClick={() => { void requestNotifications(); launch.mutate(); }} disabled={!canLaunch}>{launch.isPending ? "Создаём батч…" : "Запустить батч"}<ArrowRightIcon /></button></div></div>
      {launch.error ? <p className="error">{launch.error.message}</p> : null}
    </section>
  </Page>;
}
