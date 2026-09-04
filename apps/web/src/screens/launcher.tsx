import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { ArrowRightIcon } from "../icons.js";
import { Page, Panel, SelectMenu, Status, useData, useHotkey, requestNotifications } from "../shell.js";
import type { GalleryResult, Model, ModelCatalog, Profile, Run, Runner, Task } from "../types.js";
import { chooseRunner, cloudProviderCatalogKind, galleryCoverage, initializeTaskSelection, latestProfiles, launchModeNote, launchSummary, modelOptionLabel, ompUnavailableReason, promptCountLabel, reasoningEffortsForModel } from "../ui.js";
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
  const [runnerOverride, setRunnerOverride] = useState("");
  const [useOmpAgent, setUseOmpAgent] = useState(true);
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
    if (appliedRun.current || !requested.model || !models.data?.length) return;
    appliedRun.current = true;
    // Модель могли отключить уже после того прогона. Её id нельзя оставлять в выборе: select встал бы
    // на несуществующую опцию, а кнопка запуска молча выключилась. Откатываемся на модель по умолчанию
    // и говорим об этом; профиль, раннер и уровень мышления не переносим — они были свойством той модели.
    if (!models.data.some((model) => model.id === requested.model)) {
      setRepeatWarning("Модель того запуска больше не подключена — промпты перенесены, а модель и её параметры выберите заново.");
      return;
    }
    setModelId(requested.model);
    setProfileId(requested.profile ?? "");
    setRunnerOverride(requested.runner ?? "");
    setUseOmpAgent(requested.omp !== false);
    setCloudModelRef(requested.ref ?? "");
    setReasoningEffort(requested.effort ?? "");
    setRepeatCount(requested.repeat ?? 1);
    setWarmupAttempt(requested.warmup === true);
  }, [requested, models.data]);

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
  const usingOmpAgent = isLocalModel && useOmpAgent && Boolean(ompRunner) && Boolean(selectedModel?.capabilities.toolUse);
  const ompUnavailable = isLocalModel ? ompUnavailableReason(Boolean(ompRunner), Boolean(selectedModel?.capabilities.toolUse)) : undefined;
  const automaticRunner = selectedModel ? chooseRunner(selectedModel, [resultMode === "web" ? "coding" : "prompt"], runners.data ?? [], usingOmpAgent) : undefined;
  const runnerChoices = automaticRunner && (!hasImages || automaticRunner.kind !== "claude-code")
    ? (runners.data ?? []).filter((runner) => runner.kind === automaticRunner.kind)
    : [];
  const selectedRunner = runnerChoices.find((runner) => runner.id === runnerOverride) ?? runnerChoices.find((runner) => runner.id === automaticRunner?.id);
  const cloudProvider = cloudProviderCatalogKind(selectedModel?.provider ?? "");
  const providerCatalog = cloudProvider === "claude" ? catalog.data?.claude : cloudProvider === "codex" ? catalog.data?.codex : undefined;
  const effectiveModelRef = selectedModel?.kind === "cloud" ? cloudModelRef || selectedModel.modelRef : selectedModel?.modelRef ?? "";
  const modelOption = providerCatalog?.models.find((option) => option.id === effectiveModelRef);
  const reasoningOptions = reasoningEffortsForModel(selectedModel, modelOption?.efforts);
  // Уровень мог приехать из повтора старого запуска, где у модели был другой набор: чужое значение
  // не показать в select и нельзя отправлять на провайдер, поэтому откатываемся к умолчанию.
  const effectiveEffort = reasoningOptions.length ? (reasoningOptions.includes(reasoningEffort) ? reasoningEffort : modelOption?.defaultEffort || "") : "";
  const imageError = hasImages && !selectedModel?.capabilities.vision
    ? "У выбранной модели не отмечена поддержка изображений."
    : hasImages && automaticRunner?.kind === "claude-code"
      ? "Claude Code пока не поддерживает прикреплённые изображения в Arena."
      : undefined;
  const launch = useMutation({
    mutationFn: async () => {
      if (!selectedModel || !selectedRunner || !selectedTasks.length) throw new Error("Выберите модель и хотя бы один промпт");
      if (imageError) throw new Error(imageError);
      return api<Run>("/runs", { method: "POST", body: JSON.stringify({ taskRevisionIds: selectedTasks.map((task) => task.currentRevision.id), modelId: selectedModel.id, executionProfileId: selectedModel.kind === "local-gguf" ? selectedProfile?.id ?? null : null, runnerId: selectedRunner.id, resultMode, useOmpAgent: usingOmpAgent, modelRef: selectedModel.kind === "cloud" ? effectiveModelRef : undefined, reasoningEffort: effectiveEffort || null, repeatCount, warmupAttempt: repeatCount > 1 && warmupAttempt }) });
    },
    onSuccess: (run) => navigate({ to: "/runs/$runId", params: { runId: run.id } }),
  });
  const canLaunch = Boolean(selectedModel && selectedRunner && selectedTasks.length && !imageError) && !launch.isPending;
  // Разрешение на уведомления просим отсюда: это явное действие человека, а вне жеста часть
  // браузеров такой запрос отклоняет молча.
  const startRun = () => { void requestNotifications(); launch.mutate(); };
  useHotkey("ctrl+Enter", canLaunch ? startRun : undefined);
  const summary = launchSummary({ modelName: selectedModel?.name, taskCount: selectedTasks.length, runnerName: selectedRunner?.name, resultMode });
  const modeNote = launchModeNote({ kind: selectedModel?.kind, resultMode, usingOmpAgent, ompUnavailable });

  return <Page title="Запустить проверку модели" eyebrow="Новый запуск" intro="Выберите модель, один или несколько промптов. Остальные параметры приложение подберёт автоматически.">
    <section className="launch-card" data-empty-models={models.data?.length === 0}>
      <div className="launch-step" data-ready={Boolean(selectedModel)}><span>1</span><div className="launch-fields"><label>Подключение<SelectMenu label="Подключение" value={selectedModelId} disabled={!models.data?.length} placeholder="Выберите модель" onSelect={(value) => { setModelId(value); setCloudModelRef(""); setProfileId(""); setRunnerOverride(""); setUseOmpAgent(true); setReasoningEffort(""); }} options={[{ value: "", label: "Выберите модель" }, ...(models.data ?? []).map((model) => ({ value: model.id, label: `${model.name} · ${model.provider}` }))]} /></label>{selectedModel?.kind === "local-gguf" ? <label>Профиль запуска<SelectMenu label="Профиль запуска" value={selectedProfile?.id ?? ""} onSelect={setProfileId} options={modelProfiles.map((profile) => ({ value: profile.id, label: `${profile.name} · версия ${profile.revision}` }))} /></label> : null}{selectedModel?.kind === "cloud" ? <label>Конкретная модель<SelectMenu label="Конкретная модель" value={effectiveModelRef} onSelect={(value) => { setCloudModelRef(value); setReasoningEffort(""); }} options={[...(providerCatalog?.models.some((option) => option.id === selectedModel.modelRef) ? [] : [{ value: selectedModel.modelRef ?? "", label: selectedModel.modelRef ?? "" }]), ...(providerCatalog?.models ?? []).map((option) => ({ value: option.id, label: modelOptionLabel(option) }))]} /></label> : null}{reasoningOptions.length ? <label>Уровень обдумывания<SelectMenu label="Уровень обдумывания" value={effectiveEffort} onSelect={setReasoningEffort} options={[{ value: "", label: "По умолчанию" }, ...reasoningOptions.map((effort) => ({ value: effort, label: effort }))]} /><small>Показывается только для моделей с отмеченной поддержкой reasoning.</small></label> : null}</div><Link to="/models">Подключить модель</Link></div>
      <div className="launch-step prompt-step" data-ready={selectedTasks.length > 0}><span>2</span><PromptPicker tasks={tasks.data} selectedIds={selectedTaskIds} setSelectedIds={setSelectedTaskIds} coverage={coverage} modelId={selectedModelId} /></div>
      <div className="launch-step" data-ready={Boolean(selectedRunner)}>
        <span>3</span>
        <div className="launch-fields">
          <fieldset className="result-mode">
            <legend>Что должна вернуть модель</legend>
            <label><input type="radio" name="resultMode" checked={resultMode === "web"} onChange={() => { setResultMode("web"); setRunnerOverride(""); }} />Готовое web-приложение</label>
            <label><input type="radio" name="resultMode" checked={resultMode === "text"} onChange={() => { setResultMode("text"); setRunnerOverride(""); }} />Текстовый ответ</label>
          </fieldset>
          {isLocalModel ? <fieldset className="result-mode">
            <legend>Среда локальной модели</legend>
            <label><input type="radio" name="localPromptMode" checked={usingOmpAgent} onChange={() => { setUseOmpAgent(true); setRunnerOverride(""); }} disabled={!ompRunner || !selectedModel?.capabilities.toolUse} />OMP-среда</label>
            <label><input type="radio" name="localPromptMode" checked={!usingOmpAgent} onChange={() => { setUseOmpAgent(false); setRunnerOverride(""); }} />{resultMode === "web" ? "Без обвязки" : "Голая модель"}</label>
          </fieldset> : null}
        </div>
        <span className="launch-mode-note">{modeNote}</span>
      </div>
      <details className="advanced"><summary>Дополнительные настройки</summary><label>Способ запуска<SelectMenu label="Способ запуска" value={runnerChoices.some((runner) => runner.id === runnerOverride) ? runnerOverride : ""} onSelect={(value) => { const runner = runnerChoices.find((item) => item.id === value); setUseOmpAgent(isLocalModel && runner?.kind === "omp"); setRunnerOverride(value); }} options={[{ value: "", label: `Автоматически: ${automaticRunner?.name ?? "не определён"}` }, ...runnerChoices.map((runner) => ({ value: runner.id, label: runner.name }))]} /></label><label>Повторов каждого промпта<SelectMenu label="Повторов каждого промпта" value={String(repeatCount)} onSelect={(value) => setRepeatCount(Number(value))} options={[1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) }))} /><small>Повторы измеряют разброс скорости: ответ и оценка остаются от первого прогона.</small></label>{repeatCount > 1 ? <label className="checkbox-row"><input type="checkbox" checked={warmupAttempt} onChange={(event) => setWarmupAttempt(event.currentTarget.checked)} />Прогревочный прогон перед замерами</label> : null}</details>
      <div className="launch-footer"><dl className="launch-summary" aria-label="Параметры запуска">{summary.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl><div className="launch-action"><div><strong>{selectedTasks.length ? promptCountLabel(selectedTasks.length) : "Выберите хотя бы один промпт"}</strong><small>{imageError ?? (selectedRunner ? `через ${selectedRunner.name}` : "Добавьте модель и промпт")}</small></div><button className="primary launch-button" title="Ctrl+Enter" onClick={startRun} disabled={!canLaunch}>{launch.isPending ? "Создаём запуск…" : "Запустить"}<ArrowRightIcon /></button></div></div>
      {repeatWarning ? <p className="error">{repeatWarning}</p> : null}
      {launch.error ? <p className="error">{launch.error.message}</p> : null}
    </section>
    {active.length ? <Panel title="Сейчас выполняется" action={<Link to="/runs">Все результаты <ArrowRightIcon /></Link>}><div className="run-list">{active.map((run) => <Link className="run-row" key={run.id} to="/runs/$runId" params={{ runId: run.id }}><Status value={run.status} /><span className="run-row-copy"><strong>{models.data?.find((model) => model.id === run.model_id)?.name ?? "Модель"}</strong><small>{[runners.data?.find((runner) => runner.id === run.runner_id)?.name ?? run.runner_id, run.activeTaskName].filter(Boolean).join(" · ")}</small></span><span className="run-row-score run-row-score-none">{run.status === "pending" ? "В очереди" : "Выполняется"}</span><time dateTime={run.created_at} title={new Date(run.created_at).toLocaleString("ru-RU")}>{new Date(run.created_at).toLocaleString("ru-RU")}</time></Link>)}</div></Panel> : null}
  </Page>;
}
