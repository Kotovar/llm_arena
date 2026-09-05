import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { ArrowRightIcon } from "../icons.js";
import { Page, Panel, SelectMenu, Status, useData, useHotkey, requestNotifications } from "../shell.js";
import type { BatchCreated, GalleryResult, Model, ModelCatalog, Profile, Run, Runner, Task } from "../types.js";
import { chooseRunner, cloudProviderCatalogKind, galleryCoverage, type Harness, harnessLabel, initializeTaskSelection, latestProfiles, launchModeNote, launchSummary, modelOptionLabel, ompUnavailableReason, plural, promptCountLabel, reasoningEffortsForModel, usableHarnesses } from "../ui.js";
import { HarnessPicker } from "./harness-picker.js";
import { PromptPicker } from "./prompt-picker.js";

export function Launcher() {
  const tasks = useData<Task[]>("tasks", "/tasks");
  const models = useData<Model[]>("models", "/models");
  const profiles = useData<Profile[]>("profiles", "/profiles");
  const runners = useData<Runner[]>("runners", "/runners");
  const catalog = useData<ModelCatalog>("model-catalog", "/model-catalog");
  const gallery = useData<GalleryResult[]>("gallery", "/gallery");
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: (query) => query.state.data?.some((run) => run.status === "running" || run.status === "pending") ? 1_000 : 10_000 });
  const navigate = useNavigate();
  const [modelId, setModelId] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[] | null>(null);
  const requested = useSearch({ from: "/" });
  const appliedTask = useRef<string | undefined>(undefined);
  const [resultMode, setResultMode] = useState<"text" | "web">(requested.mode === "text" ? "text" : "web");
  const [harnesses, setHarnesses] = useState<Harness[]>(["omp"]);
  const [cloudModelRef, setCloudModelRef] = useState("");
  const [profileId, setProfileId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [repeatCount, setRepeatCount] = useState(1);
  const [warmupAttempt, setWarmupAttempt] = useState(false);
  useEffect(() => {
    if (!tasks.data) return;
    // Приходим из результата с «повторить»: оставляем ровно те промпты, что были в исходном запуске
    // (`tasks`) или один выбранный (`task`). Промпт мог с тех пор смениться — берём его текущую версию.
    // Применяем один раз на значение: рефетч tasks не должен стирать то, что пользователь выбрал потом.
    const wanted = requested.tasks ?? requested.task;
    const repeated = wanted && appliedTask.current !== wanted
      ? tasks.data.filter((task) => wanted.split(",").includes(task.id))
      : undefined;
    appliedTask.current = wanted;
    if (repeated?.length) { setSelectedTaskIds(repeated.map((task) => task.currentRevision.id)); return; }
    setSelectedTaskIds((current) => initializeTaskSelection(current, tasks.data!.map((task) => task.currentRevision.id)));
  }, [tasks.data, requested.task, requested.tasks]);
  // Остальные параметры повтора применяем один раз: дальше экран принадлежит пользователю.
  const appliedRun = useRef(false);
  const [repeatWarning, setRepeatWarning] = useState("");
  useEffect(() => {
    // Раннеры ждём наравне с моделями: по ним восстанавливается обвязка, а запросы независимы —
    // без ожидания повтор pi-прогона молча уезжал бы на другую обвязку.
    if (appliedRun.current || !requested.model || !models.data?.length || !runners.data) return;
    appliedRun.current = true;
    // Модель могли отключить уже после того прогона. Её id нельзя оставлять в выборе: select встал бы
    // на несуществующую опцию, а кнопка запуска молча выключилась. Откатываемся на модель по умолчанию
    // и говорим об этом; профиль, раннер и уровень мышления не переносим — они были свойством той модели.
    const repeated = models.data.find((model) => model.id === requested.model);
    if (!repeated) {
      setRepeatWarning("Модель того запуска больше не подключена — промпты перенесены, а модель и её параметры выберите заново.");
      return;
    }
    setModelId(requested.model);
    setProfileId(requested.profile ?? "");
    // Обвязку восстанавливаем по раннеру прошлого прогона: флаг `omp` не отличает pi от голой модели.
    const previous = runners.data.find((runner) => runner.id === requested.runner);
    const wanted: Harness = previous?.kind === "pi" ? "pi" : requested.omp === false ? "bare" : "omp";
    setHarnesses([wanted]);
    // Раннер могли убрать из конфигурации, у модели — снять Tools, а голой модели в web больше нет.
    // Молча подменить среду нельзя: повтор в другой обвязке — это уже не повтор. Исчезнувший раннер
    // сюда же: по нему не восстановить обвязку, и выбор молча уехал бы на OMP.
    const wantedAvailable = (!requested.runner || previous) && (wanted === "bare"
      ? requested.mode === "text"
      : repeated.capabilities.toolUse && runners.data.some((runner) => runner.kind === wanted));
    if (!wantedAvailable) setRepeatWarning("Среда того запуска сейчас недоступна — прогон пойдёт в другой, проверьте выбор.");
    setCloudModelRef(requested.ref ?? "");
    setReasoningEffort(requested.effort ?? "");
    setRepeatCount(requested.repeat ?? 1);
    setWarmupAttempt(requested.warmup === true);
  }, [requested, models.data, runners.data]);

  const active = runs.data?.filter((run) => run.status === "running" || run.status === "pending") ?? [];
  const selectedModelId = modelId || models.data?.[0]?.id || "";
  const selectedModel = models.data?.find((model) => model.id === selectedModelId);
  const modelProfiles = latestProfiles(profiles.data ?? []).filter((profile) => profile.modelId === selectedModelId);
  const selectedProfile = modelProfiles.find((profile) => profile.id === profileId) ?? modelProfiles[0];
  const selected = new Set(selectedTaskIds ?? []);
  const selectedTasks = (tasks.data ?? []).filter((task) => selected.has(task.currentRevision.id));
  // Галерея — единственный источник «успешных» результатов, и её ответ уже кеширован react-query.
  const coverage = galleryCoverage(gallery.data ?? []);
  const isLocalModel = selectedModel?.kind === "local-gguf";
  const hasImages = selectedTasks.some((task) => task.currentRevision.images.length > 0);
  const ompRunner = runners.data?.find((runner) => runner.kind === "omp");
  const piRunner = runners.data?.find((runner) => runner.kind === "pi");
  const toolUse = Boolean(selectedModel?.capabilities.toolUse);
  // Голая модель осталась только в текстовом режиме: там это llama-chat без агента и инструментов.
  // В web она была тем же OMP с выключенными расширениями — эту точку оси закрывает pi.
  const harnessAvailable = { omp: Boolean(ompRunner) && toolUse, pi: Boolean(piRunner) && toolUse, bare: resultMode === "text" };
  const activeHarnesses = isLocalModel ? usableHarnesses(harnesses, harnessAvailable) : [];
  const usingOmpAgent = activeHarnesses.includes("omp");
  const usingPi = activeHarnesses.includes("pi");
  const ompUnavailable = isLocalModel ? ompUnavailableReason(Boolean(ompRunner), toolUse) : undefined;
  const taskKinds: Task["currentRevision"]["kind"][] = [resultMode === "web" ? "coding" : "prompt"];
  const automaticRunner = selectedModel ? chooseRunner(selectedModel, taskKinds, runners.data ?? [], usingPi ? "pi" : usingOmpAgent ? "omp" : "bare") : undefined;
  const selectedRunner = automaticRunner && (!hasImages || automaticRunner.kind !== "claude-code") ? automaticRunner : undefined;
  const cloudProvider = cloudProviderCatalogKind(selectedModel?.provider ?? "");
  const providerCatalog = cloudProvider === "claude" ? catalog.data?.claude : cloudProvider === "codex" ? catalog.data?.codex : undefined;
  const effectiveModelRef = selectedModel?.kind === "cloud" ? cloudModelRef || selectedModel.modelRef : selectedModel?.modelRef ?? "";
  const modelOption = providerCatalog?.models.find((option) => option.id === effectiveModelRef);
  const reasoningOptions = reasoningEffortsForModel(selectedModel, modelOption?.efforts);
  // Уровень мог приехать из повтора старого запуска, где у модели был другой набор: чужое значение
  // не показать в select и нельзя отправлять на провайдер, поэтому откатываемся к умолчанию.
  const effectiveEffort = reasoningOptions.length ? (reasoningOptions.includes(reasoningEffort) ? reasoningEffort : modelOption?.defaultEffort || "") : "";
  // Отмечено больше одной обвязки — это уже не один прогон: одна модель × N обвязок уходит батчем,
  // прогоны идут подряд в порядке галочек (OMP → pi → голая), и порядок виден на странице батча.
  const harnessRuns = selectedModel && activeHarnesses.length > 1
    ? activeHarnesses.map((item) => ({ harness: item, runner: chooseRunner(selectedModel, taskKinds, runners.data ?? [], item) }))
    : [];
  const batchLaunch = harnessRuns.length > 1;
  const harnessRunners = harnessRuns.flatMap((item) => item.runner ? [{ harness: item.harness, runner: item.runner }] : []);
  const imageError = hasImages && !selectedModel?.capabilities.vision
    ? "У выбранной модели не отмечена поддержка изображений."
    : hasImages && automaticRunner?.kind === "claude-code"
      ? "Claude Code пока не поддерживает прикреплённые изображения в Arena."
      : undefined;
  const launch = useMutation({
    mutationFn: async () => {
      if (!selectedModel || !selectedTasks.length) throw new Error("Выберите модель и хотя бы один промпт");
      if (imageError) throw new Error(imageError);
      const taskRevisionIds = selectedTasks.map((task) => task.currentRevision.id);
      const executionProfileId = selectedModel.kind === "local-gguf" ? selectedProfile?.id ?? null : null;
      if (batchLaunch) {
        if (harnessRunners.length !== harnessRuns.length) throw new Error("Для выбранных обвязок не нашлось способа запуска");
        return api<BatchCreated>("/batches", { method: "POST", body: JSON.stringify({ taskRevisionIds, models: harnessRunners.map((item) => ({ modelId: selectedModel.id, executionProfileId, runnerId: item.runner.id, useOmpAgent: item.harness === "omp", reasoningEffort: effectiveEffort || null })), resultMode, repeatCount, warmupAttempt: repeatCount > 1 && warmupAttempt }) });
      }
      if (!selectedRunner) throw new Error("Выберите модель и хотя бы один промпт");
      return api<Run>("/runs", { method: "POST", body: JSON.stringify({ taskRevisionIds, modelId: selectedModel.id, executionProfileId, runnerId: selectedRunner.id, resultMode, useOmpAgent: usingOmpAgent, modelRef: selectedModel.kind === "cloud" ? effectiveModelRef : undefined, reasoningEffort: effectiveEffort || null, repeatCount, warmupAttempt: repeatCount > 1 && warmupAttempt }) });
    },
    onSuccess: (created) => "batchId" in created
      ? navigate({ to: "/batch", search: { id: created.batchId } })
      : navigate({ to: "/runs/$runId", params: { runId: created.id } }),
  });
  const harnessOrder = harnessRunners.map((item) => harnessLabel(item.runner.kind, item.harness === "omp" ? 1 : 0)).join(" → ");
  const canLaunch = Boolean(selectedModel && selectedTasks.length && !imageError && (!isLocalModel || activeHarnesses.length) && (batchLaunch ? harnessRunners.length === harnessRuns.length : selectedRunner)) && !launch.isPending;
  // Разрешение на уведомления просим отсюда: это явное действие человека, а вне жеста часть
  // браузеров такой запрос отклоняет молча.
  const startRun = () => { void requestNotifications(); launch.mutate(); };
  useHotkey("ctrl+Enter", canLaunch ? startRun : undefined);
  const summary = launchSummary({ modelName: selectedModel?.name, taskCount: selectedTasks.length, runnerName: batchLaunch ? harnessOrder : selectedRunner?.name, resultMode });
  const modeNote = batchLaunch
    ? "Обвязки идут подряд одним батчем: вторая — уже на прогретой карте, поэтому спорную разницу перепроверяйте обратным порядком."
    : launchModeNote({ kind: selectedModel?.kind, resultMode, usingOmpAgent, usingPi, ompUnavailable });

  return <Page title="Запустить проверку модели" eyebrow="Новый запуск" intro="Выберите модель, один или несколько промптов. Остальные параметры приложение подберёт автоматически.">
    <section className="launch-card" data-empty-models={models.data?.length === 0}>
      <div className="launch-step" data-ready={Boolean(selectedModel)}><span>1</span><div className="launch-fields"><label>Подключение<SelectMenu label="Подключение" value={selectedModelId} disabled={!models.data?.length} placeholder="Выберите модель" onSelect={(value) => { setModelId(value); setCloudModelRef(""); setProfileId(""); setHarnesses(["omp"]); setReasoningEffort(""); }} options={[{ value: "", label: "Выберите модель" }, ...(models.data ?? []).map((model) => ({ value: model.id, label: `${model.name} · ${model.provider}` }))]} /></label>{selectedModel?.kind === "local-gguf" ? <label>Профиль запуска<SelectMenu label="Профиль запуска" value={selectedProfile?.id ?? ""} onSelect={setProfileId} options={modelProfiles.map((profile) => ({ value: profile.id, label: `${profile.name} · версия ${profile.revision}` }))} /></label> : null}{selectedModel?.kind === "cloud" ? <label>Конкретная модель<SelectMenu label="Конкретная модель" value={effectiveModelRef} onSelect={(value) => { setCloudModelRef(value); setReasoningEffort(""); }} options={[...(providerCatalog?.models.some((option) => option.id === selectedModel.modelRef) ? [] : [{ value: selectedModel.modelRef ?? "", label: selectedModel.modelRef ?? "" }]), ...(providerCatalog?.models ?? []).map((option) => ({ value: option.id, label: modelOptionLabel(option) }))]} /></label> : null}{reasoningOptions.length ? <label>Уровень обдумывания<SelectMenu label="Уровень обдумывания" value={effectiveEffort} onSelect={setReasoningEffort} options={[{ value: "", label: "По умолчанию" }, ...reasoningOptions.map((effort) => ({ value: effort, label: effort }))]} /><small>Показывается только для моделей с отмеченной поддержкой reasoning.</small></label> : null}</div><Link to="/models">Подключить модель</Link></div>
      <div className="launch-step prompt-step" data-ready={selectedTasks.length > 0}><span>2</span><PromptPicker tasks={tasks.data} selectedIds={selectedTaskIds} setSelectedIds={setSelectedTaskIds} coverage={coverage} modelId={selectedModelId} /></div>
      <div className="launch-step" data-ready={Boolean(selectedRunner)}>
        <span>3</span>
        <div className="launch-fields">
          <fieldset className="result-mode">
            <legend>Что должна вернуть модель</legend>
            <label><input type="radio" name="resultMode" checked={resultMode === "web"} onChange={() => setResultMode("web")} />Готовое web-приложение</label>
            <label><input type="radio" name="resultMode" checked={resultMode === "text"} onChange={() => setResultMode("text")} />Текстовый ответ</label>
          </fieldset>
          {isLocalModel ? <HarnessPicker value={activeHarnesses} onChange={setHarnesses} available={harnessAvailable} bareLabel={harnessAvailable.bare ? "Голая модель" : undefined} /> : null}
        </div>
        <span className="launch-mode-note">{modeNote}</span>
      </div>
      <details className="advanced"><summary>Дополнительные настройки</summary><label>Повторов каждого промпта<SelectMenu label="Повторов каждого промпта" value={String(repeatCount)} onSelect={(value) => setRepeatCount(Number(value))} options={[1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) }))} /><small>Повторы измеряют разброс скорости: ответ и оценка остаются от первого прогона.</small></label>{repeatCount > 1 ? <label className="checkbox-row"><input type="checkbox" checked={warmupAttempt} onChange={(event) => setWarmupAttempt(event.currentTarget.checked)} />Прогревочный прогон перед замерами</label> : null}</details>
      <div className="launch-footer"><dl className="launch-summary" aria-label="Параметры запуска">{summary.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl><div className="launch-action"><div><strong>{selectedTasks.length ? promptCountLabel(selectedTasks.length) : "Выберите хотя бы один промпт"}</strong><small>{imageError ?? (batchLaunch ? (harnessRunners.length === harnessRuns.length ? harnessOrder : "Для выбранных обвязок нет способа запуска") : selectedRunner ? `через ${selectedRunner.name}` : "Добавьте модель и промпт")}</small></div><button className="primary launch-button" title="Ctrl+Enter" onClick={startRun} disabled={!canLaunch}>{launch.isPending ? (batchLaunch ? "Создаём батч…" : "Создаём запуск…") : batchLaunch ? `Запустить ${harnessRuns.length} ${plural(harnessRuns.length, "прогон", "прогона", "прогонов")} подряд` : "Запустить"}<ArrowRightIcon /></button></div></div>
      {repeatWarning ? <p className="error">{repeatWarning}</p> : null}
      {launch.error ? <p className="error">{launch.error.message}</p> : null}
    </section>
    {active.length ? <Panel title="Сейчас выполняется" action={<Link to="/runs">Все результаты <ArrowRightIcon /></Link>}><div className="run-list">{active.map((run) => <Link className="run-row" key={run.id} to="/runs/$runId" params={{ runId: run.id }}><Status value={run.status} /><span className="run-row-copy"><strong>{models.data?.find((model) => model.id === run.model_id)?.name ?? "Модель"}</strong><small>{[runners.data?.find((runner) => runner.id === run.runner_id)?.name ?? run.runner_id, run.activeTaskName].filter(Boolean).join(" · ")}</small></span><span className="run-row-score run-row-score-none">{run.status === "pending" ? "В очереди" : "Выполняется"}</span><time dateTime={run.created_at} title={new Date(run.created_at).toLocaleString("ru-RU")}>{new Date(run.created_at).toLocaleString("ru-RU")}</time></Link>)}</div></Panel> : null}
  </Page>;
}
