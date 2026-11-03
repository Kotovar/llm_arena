import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api.js";
import { ArrowLeftIcon, ArrowRightIcon } from "../icons.js";
import { Page, Panel, SelectMenu, Status, useData, usePrompts, requestNotifications } from "../shell.js";
import type { TaskOutcome } from "@llm-arena/shared";
import type { BatchCreated, BatchProgress, Model, ModelCatalog, Profile, Runner, Task } from "../types.js";
import { batchRunSummary, chooseRunner, cloudModelCatalog, effortLabel, type Harness, harnessAxisLabel, latestProfiles, modelOptionLabel, outcomeLabels, plural, reasoningEffortsForModel, usableHarnesses } from "../ui.js";
import { HarnessPicker } from "./harness-picker.js";
import { PromptPicker } from "./prompt-picker.js";

/** Параметры прогона одной модели в батче: те же, что подобрал бы лаунчер для неё одной. */
function batchModelEntry(model: Model, runners: Runner[], profiles: Profile[], resultMode: "text" | "web", harness: Harness, settings: { modelRef: string; effort: string }) {
  // Обвязка есть только у локальной модели, и только если она умеет инструменты, а раннер настроен.
  // Иначе выбор сводится к голому запуску — такие дубли схлопываются ниже, а не блокируют батч.
  const available = model.kind === "local-gguf" && model.capabilities.toolUse && runners.some((runner) => runner.kind === harness);
  const effective = available ? harness : "bare";
  const runner = chooseRunner(model, [resultMode === "web" ? "coding" : "prompt"], runners, effective);
  if (!runner) return undefined;
  return {
    modelId: model.id,
    executionProfileId: model.kind === "local-gguf" ? latestProfiles(profiles).find((profile) => profile.modelId === model.id)?.id ?? null : null,
    runnerId: runner.id,
    useOmpAgent: effective === "omp",
    ...(model.kind === "cloud" ? { modelRef: settings.modelRef } : {}),
    ...(settings.effort ? { reasoningEffort: settings.effort } : {}),
  };
}

/** У облачного CLI обвязку не выключить: подписи у него нет, и выдумывать «без обвязки» нельзя. */
function HarnessMark({ runnerKind, useOmpAgent }: { runnerKind: string | undefined; useOmpAgent: number }) {
  const label = harnessAxisLabel(runnerKind, useOmpAgent === 1);
  return label ? <em className="row-harness">{label}</em> : null;
}

function BatchProgressView({ batchId }: { batchId: string }) {
  const runners = useData<Runner[]>("runners", "/runners");
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
  // Батч по обвязкам — это одна модель несколько раз: сравнивать его надо попарно, а не матрицей.
  const singleModel = new Set(batch.data.models.map((model) => model.modelId)).size === 1;
  const manyHarnesses = new Set(batch.data.models.map((model) => `${model.runner_id}|${model.use_omp_agent}`)).size > 1;
  // Web-результаты сравнивает галерея — она и есть матрица модель × промпт; текстовые — /compare
  // попарно, поэтому туда уходят первые два прогона батча.
  const compare = batch.data.models.length > 1 && (singleModel || batch.data.resultMode === "text")
    ? <Link to="/compare" search={{ left: batch.data.models[0]!.runId, right: batch.data.models[1]!.runId }}>{singleModel && manyHarnesses ? "Сравнить обвязки" : "Сравнить ответы"} <ArrowRightIcon /></Link>
    : batch.data.resultMode === "web"
      ? <Link to="/gallery" search={{ prompts: batch.data.taskRevisionIds.join(","), models: batch.data.modelIds.join(",") }}>Сравнить в галерее <ArrowRightIcon /></Link>
      : null;
  return <Panel title={batch.data.title} action={batch.data.finished
    ? compare
    : <button type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Остановить батч</button>}>
    <p className="batch-active">{batch.data.active.length ? batch.data.active.map((item) => `${item.modelName} · ${item.taskName}`).join("; ") : batch.data.finished ? "Батч завершён" : "Подготовка запусков"}</p>
    {counts.length ? <dl className="batch-counts">{counts.map(([outcome, count]) => <div key={outcome}><dt>{outcomeLabels[outcome as TaskOutcome]}</dt><dd>{count}</dd></div>)}</dl> : null}
    <div className="run-list">{batch.data.models.map((model) => <Link className="run-row" key={model.runId} to="/runs/$runId" params={{ runId: model.runId }}>
      <Status value={model.status} />
      <span className="run-row-copy"><strong>{model.modelName}{manyHarnesses ? <HarnessMark runnerKind={runners.data?.find((runner) => runner.id === model.runner_id)?.kind} useOmpAgent={model.use_omp_agent} /> : null}</strong><small>{model.prompts.length} из {model.planned} {plural(model.planned, "промпт", "промпта", "промптов")}</small></span>
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
  const tasks = usePrompts("ordinary");
  const models = useData<Model[]>("models", "/models");
  const profiles = useData<Profile[]>("profiles", "/profiles");
  const runners = useData<Runner[]>("runners", "/runners");
  const catalog = useData<ModelCatalog>("model-catalog", "/model-catalog");
  const navigate = useNavigate();
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[] | null>([]);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [resultMode, setResultMode] = useState<"text" | "web">("web");
  const [harnesses, setHarnesses] = useState<Harness[]>(["omp"]);
  const [modelSettings, setModelSettings] = useState<Record<string, { modelRef: string; effort: string }>>({});
  const chosenModels = (models.data ?? []).filter((model) => modelIds.includes(model.id));
  const configurations = chosenModels.map((model) => {
    const providerCatalog = cloudModelCatalog(model, catalog.data);
    const modelRef = modelSettings[model.id]?.modelRef || model.modelRef;
    const option = providerCatalog?.models.find((item) => item.id === modelRef);
    const efforts = reasoningEffortsForModel(model, option?.efforts);
    const chosenEffort = modelSettings[model.id]?.effort ?? "";
    const effort = efforts.length ? (efforts.includes(chosenEffort) ? chosenEffort : option?.defaultEffort || "") : "";
    return { model, providerCatalog, modelRef, efforts, effort };
  });
  // Голая модель есть только в текстовом режиме (llama-chat); в web её место занимает pi.
  const harnessAvailable = { omp: (runners.data ?? []).some((runner) => runner.kind === "omp"), pi: (runners.data ?? []).some((runner) => runner.kind === "pi"), bare: resultMode === "text" };
  const activeHarnesses = usableHarnesses(harnesses, harnessAvailable);
  // Модель снаружи, обвязка внутри: два прогона одной модели идут подряд, их и сравнивают.
  const planned = configurations.map((settings) => (settings.model.kind === "local-gguf" ? activeHarnesses : ["bare" as const]).map((harness) => batchModelEntry(settings.model, runners.data ?? [], profiles.data ?? [], resultMode, harness, settings)));
  const unavailable = chosenModels.filter((_, index) => !planned[index]!.length || planned[index]!.some((entry) => !entry));
  // Модель без инструментов не поднимет ни OMP, ни pi: она пойдёт голой. Молчать об этом нельзя —
  // на экране отмечена агентная среда, а в замер попадёт совсем другая обвязка.
  const withoutTools = chosenModels.filter((model) => model.kind === "local-gguf" && !model.capabilities.toolUse && !unavailable.includes(model) && activeHarnesses.some((harness) => harness !== "bare"));
  // Обвязка без раннера сводится к голому запуску: у одной модели могло получиться два одинаковых прогона.
  const entries = [...new Map(planned.flat().flatMap((entry) => entry ? [[`${entry.modelId}|${entry.runnerId}|${entry.useOmpAgent}`, entry] as const] : [])).values()];
  const localChosen = chosenModels.some((model) => model.kind === "local-gguf");
  const promptCount = selectedTaskIds?.length ?? 0;
  const launch = useMutation({
    mutationFn: () => api<BatchCreated>("/batches", { method: "POST", body: JSON.stringify({
      taskRevisionIds: selectedTaskIds ?? [],
      models: entries,
      resultMode,
    }) }),
    onSuccess: (created) => navigate({ to: "/batch", search: { id: created.batchId } }),
  });
  const canLaunch = promptCount > 0 && entries.length > 0 && !unavailable.length && !launch.isPending;
  // Из списка батчей сюда ведёт одна ссылка — обратно должна вести тоже одна, а не «Результаты» плюс вкладка.
  if (id) return <div className="batch-progress-page"><Page title="Массовый запуск" eyebrow="Батч"><p className="actions"><Link to="/runs" search={{ tab: "batches" }}><ArrowLeftIcon />Назад</Link><Link to="/batch">Собрать новый батч</Link></p><BatchProgressView batchId={id} /></Page></div>;
  const blockedReason = !chosenModels.length ? "Выберите хотя бы одну модель."
    : !promptCount ? "Выберите хотя бы один промпт."
    : unavailable.length ? "Для выбранных моделей нет способа запуска. Проверьте среду и формат результата."
    : undefined;
  const dataError = models.error ?? tasks.error ?? runners.error ?? profiles.error ?? catalog.error;
  return <div className="launcher-page batch-page"><Page title="Массовый запуск" eyebrow="Батч" intro="Подписочные модели выполняются параллельно. Одновременно с ними может работать одна локальная модель; остальные локальные ждут очередь.">
    <nav className="launcher-shortcuts" aria-label="Действия с батчами"><Link to="/">Проверить одну модель <ArrowRightIcon /></Link><Link to="/runs" search={{ tab: "batches" }}>История прогонов <ArrowRightIcon /></Link></nav>
    {dataError ? <p className="error" role="alert">Не удалось загрузить параметры запуска: {dataError.message}</p> : null}
    <section className="launch-card">
      <div className="launch-step" data-ready={chosenModels.length > 0}><span aria-label="Шаг 1">1</span><fieldset className="prompt-picker"><legend><strong>Какие модели сравнить</strong><small>{chosenModels.length} из {models.data?.length ?? 0}</small></legend><div className="picker-actions"><button type="button" onClick={() => setModelIds((models.data ?? []).map((model) => model.id))}>Выбрать все модели</button><button type="button" onClick={() => setModelIds([])}>Снять выбор моделей</button><Link to="/models">Подключить модель</Link></div><div className="prompt-options">{(models.data ?? []).map((model) => <label key={model.id} className={modelIds.includes(model.id) ? "selected" : ""}><input type="checkbox" checked={modelIds.includes(model.id)} onChange={(event) => { const checked = event.currentTarget.checked; setModelIds((current) => checked ? [...current, model.id] : current.filter((item) => item !== model.id)); }} /><span><strong>{model.name}</strong><small>{model.provider}</small></span></label>)}</div>{!models.data?.length ? <p className="empty">Сначала подключите модель.</p> : null}</fieldset></div>
        {configurations.some(({ model, efforts }) => model.kind === "cloud" || efforts.length) ? <div className="batch-settings">{configurations.map(({ model, providerCatalog, modelRef, efforts, effort }) => model.kind === "cloud" || efforts.length ? <fieldset key={model.id} className="batch-model-settings">
          <legend>Настройки {model.name}</legend>
          <div className="launch-fields">
            {model.kind === "cloud" ? <label>Конкретная модель<SelectMenu label={`Конкретная модель · ${model.name}`} value={modelRef} onSelect={(value) => setModelSettings((current) => ({ ...current, [model.id]: { modelRef: value, effort: "" } }))} options={[...(providerCatalog?.models.some((option) => option.id === model.modelRef) ? [] : [{ value: model.modelRef, label: model.modelRef }]), ...(providerCatalog?.models ?? []).map((option) => ({ value: option.id, label: modelOptionLabel(option) }))]} /></label> : null}
            {efforts.length ? <label>Уровень обдумывания<SelectMenu label={`Уровень обдумывания · ${model.name}`} value={effort} onSelect={(value) => setModelSettings((current) => ({ ...current, [model.id]: { modelRef, effort: value } }))} options={[{ value: "", label: "По умолчанию" }, ...efforts.map((value) => ({ value, label: effortLabel(value) }))]} /></label> : null}
          </div>
        </fieldset> : null)}</div> : null}
      <div className="launch-step prompt-step" data-ready={promptCount > 0}><span aria-label="Шаг 2">2</span><PromptPicker tasks={tasks.data} selectedIds={selectedTaskIds} setSelectedIds={setSelectedTaskIds} /></div>
      <div className="launch-step" data-ready={entries.length > 0 && !unavailable.length}><span aria-label="Шаг 3">3</span><div className="launch-fields"><fieldset className="result-mode">
        <legend>Что должна вернуть модель</legend>
        <label><input type="radio" name="batchResultMode" checked={resultMode === "web"} onChange={() => setResultMode("web")} />Готовое web-приложение</label>
        <label><input type="radio" name="batchResultMode" checked={resultMode === "text"} onChange={() => setResultMode("text")} />Текстовый ответ</label>
      </fieldset>{localChosen ? <HarnessPicker value={activeHarnesses} onChange={setHarnesses} available={harnessAvailable} bareLabel={harnessAvailable.bare ? "Голая модель" : undefined} note="Отметьте несколько — каждая локальная модель пройдёт по каждой обвязке." /> : null}</div></div>
        <div className="launch-footer"><header className="launch-review"><span className="mono">Перед запуском</span><h2>План сравнения</h2><p>Каждая модель получит выбранный набор промптов. Подписочные работают параллельно, локальные — по одной.</p></header><dl className="launch-summary" aria-label="Параметры батча"><div><dt>Модели · {chosenModels.length}</dt><dd>{chosenModels.map((model) => model.name).join(", ") || "Не выбраны"}</dd></div><div><dt>Промпты</dt><dd>{promptCount}</dd></div><div><dt>Формат результата</dt><dd>{resultMode === "web" ? "Web-приложение" : "Текстовый ответ"}</dd></div><div><dt>Всего запусков промптов</dt><dd>{promptCount * entries.length}</dd></div></dl><p className="launch-readiness" data-ready={canLaunch} role="status" aria-label="Готовность батча">{launch.isPending ? "Подготавливаем батч…" : blockedReason ?? "Всё готово к запуску"}</p><div className="launch-action"><div><strong>{canLaunch || promptCount ? batchRunSummary(promptCount, chosenModels.length, localChosen ? activeHarnesses.length : 1, entries.length) : "Выберите модели и промпты"}</strong><small>{unavailable.length ? `Не запускается: ${unavailable.map((model) => model.name).join(", ")}` : withoutTools.length ? `Без поддержки инструментов, пойдут голой моделью: ${withoutTools.map((model) => model.name).join(", ")}` : "Подписочные — одновременно; локальные модели и их обвязки — по очереди"}</small></div><button className="primary launch-button" onClick={() => { void requestNotifications(); launch.mutate(); }} disabled={!canLaunch}>{launch.isPending ? "Создаём батч…" : "Запустить батч"}<ArrowRightIcon /></button></div></div>
      {launch.error ? <p className="error">{launch.error.message}</p> : null}
    </section>
  </Page></div>;
}
