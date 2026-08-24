import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Page, Panel, Status, useData } from "../shell.js";
import type { Benchmark, Model, ModelCatalog, Profile, Run, Runner, Task } from "../types.js";
import { chooseRunner, cloudProviderCatalogKind, initializeTaskSelection, latestProfiles, launchSummary, modelOptionLabel, ompUnavailableReason, promptCountLabel, reasoningEffortsForModel, updateTaskSelection } from "../ui.js";

export function Launcher() {
  const tasks = useData<Task[]>("tasks", "/tasks");
  const models = useData<Model[]>("models", "/models");
  const profiles = useData<Profile[]>("profiles", "/profiles");
  const runners = useData<Runner[]>("runners", "/runners");
  const catalog = useData<ModelCatalog>("model-catalog", "/model-catalog");
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: (query) => query.state.data?.some((run) => run.status === "running" || run.status === "pending") ? 1_000 : 10_000 });
  const navigate = useNavigate();
  const [modelId, setModelId] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[] | null>(null);
  const [resultMode, setResultMode] = useState<"text" | "web">("text");
  const [runnerOverride, setRunnerOverride] = useState("");
  const [useOmpAgent, setUseOmpAgent] = useState(false);
  const [cloudModelRef, setCloudModelRef] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  useEffect(() => {
    if (tasks.data) setSelectedTaskIds((current) => initializeTaskSelection(current, tasks.data!.map((task) => task.currentRevision.id)));
  }, [tasks.data]);

  const active = runs.data?.filter((run) => run.status === "running" || run.status === "pending") ?? [];
  const selectedModelId = modelId || models.data?.[0]?.id || "";
  const selectedModel = models.data?.find((model) => model.id === selectedModelId);
  const selected = new Set(selectedTaskIds ?? []);
  const selectedTasks = (tasks.data ?? []).filter((task) => selected.has(task.currentRevision.id));
  const isLocalModel = selectedModel?.kind === "local-gguf";
  const hasImages = selectedTasks.some((task) => task.currentRevision.images.length > 0);
  const ompRunner = runners.data?.find((runner) => runner.kind === "omp");
  const usingOmpAgent = isLocalModel && useOmpAgent && Boolean(ompRunner) && Boolean(selectedModel?.capabilities.toolUse);
  const ompUnavailable = isLocalModel ? ompUnavailableReason(Boolean(ompRunner), Boolean(selectedModel?.capabilities.toolUse)) : undefined;
  const runnerChoices = (runners.data ?? []).filter((runner) => (runner.kind !== "omp" || selectedModel?.capabilities.toolUse) && (!hasImages || runner.kind !== "claude-code"));
  const automaticRunner = selectedModel ? chooseRunner(selectedModel, [resultMode === "web" ? "coding" : "prompt"], runnerChoices, usingOmpAgent) : undefined;
  const selectedRunner = runnerChoices.find((runner) => runner.id === runnerOverride) ?? automaticRunner;
  const cloudProvider = cloudProviderCatalogKind(selectedModel?.provider ?? "");
  const providerCatalog = cloudProvider === "claude" ? catalog.data?.claude : cloudProvider === "codex" ? catalog.data?.codex : undefined;
  const effectiveModelRef = selectedModel?.kind === "cloud" ? cloudModelRef || selectedModel.modelRef : selectedModel?.modelRef ?? "";
  const modelOption = providerCatalog?.models.find((option) => option.id === effectiveModelRef);
  const reasoningOptions = reasoningEffortsForModel(selectedModel, modelOption?.efforts);
  const effectiveEffort = reasoningOptions.length ? reasoningEffort || modelOption?.defaultEffort || "" : "";
  const imageError = hasImages && !selectedModel?.capabilities.vision
    ? "У выбранной модели не отмечена поддержка изображений."
    : hasImages && selectedRunner?.kind === "claude-code"
      ? "Claude Code пока не поддерживает прикреплённые изображения в Arena."
      : undefined;
  const launch = useMutation({
    mutationFn: async () => {
      if (!selectedModel || !selectedRunner || !selectedTasks.length) throw new Error("Выберите модель и хотя бы один промпт");
      if (imageError) throw new Error(imageError);
      const benchmark = await api<Benchmark>("/benchmarks", { method: "POST", body: JSON.stringify({
        name: selectedTasks.length === 1 ? selectedTasks[0]!.currentRevision.name : `${promptCountLabel(selectedTasks.length)} · ${new Date().toLocaleString("ru-RU")}`,
        taskRevisionIds: selectedTasks.map((task) => task.currentRevision.id),
      }) });
      const profile = latestProfiles(profiles.data ?? []).find((item) => item.modelId === selectedModel.id);
      return api<Run>("/runs", { method: "POST", body: JSON.stringify({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: selectedModel.id, executionProfileId: profile?.id ?? null, runnerId: selectedRunner.id, resultMode, useOmpAgent: usingOmpAgent, modelRef: selectedModel.kind === "cloud" ? effectiveModelRef : undefined, reasoningEffort: effectiveEffort || null }) });
    },
    onSuccess: (run) => navigate({ to: "/runs/$runId", params: { runId: run.id } }),
  });
  const allTaskIds = tasks.data?.map((task) => task.currentRevision.id) ?? [];
  const summary = launchSummary({ modelName: selectedModel?.name, taskCount: selectedTasks.length, runnerName: selectedRunner?.name, resultMode });

  return <Page title="Запустить проверку модели" eyebrow="Новый запуск" intro="Выберите модель, один или несколько промптов. Остальные параметры приложение подберёт автоматически.">
    <section className="launch-card" data-empty-models={models.data?.length === 0}>
      <div className="launch-step" data-ready={Boolean(selectedModel)}><span>1</span><div className="launch-fields"><label>Подключение<select value={selectedModelId} onChange={(event) => { setModelId(event.currentTarget.value); setCloudModelRef(""); setRunnerOverride(""); setUseOmpAgent(false); setReasoningEffort(""); }} disabled={!models.data?.length}><option value="">Выберите модель</option>{models.data?.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.provider}</option>)}</select></label>{selectedModel?.kind === "cloud" ? <label>Конкретная модель<select value={effectiveModelRef} onChange={(event) => { setCloudModelRef(event.currentTarget.value); setReasoningEffort(""); }}>{!providerCatalog?.models.some((option) => option.id === selectedModel.modelRef) ? <option value={selectedModel.modelRef}>{selectedModel.modelRef}</option> : null}{providerCatalog?.models.map((option) => <option key={option.id} value={option.id}>{modelOptionLabel(option)}</option>)}</select></label> : null}{reasoningOptions.length ? <label>Уровень обдумывания<select value={effectiveEffort} onChange={(event) => setReasoningEffort(event.currentTarget.value)}><option value="">По умолчанию</option>{reasoningOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select><small>Показывается только для моделей с отмеченной поддержкой reasoning.</small></label> : null}</div><Link to="/models">Подключить модель</Link></div>
      <div className="launch-step prompt-step" data-ready={selectedTasks.length > 0}><span>2</span><fieldset className="prompt-picker"><legend><strong>Какие промпты запустить</strong><small>{selectedTasks.length} из {tasks.data?.length ?? 0}</small></legend><div className="picker-actions"><button type="button" onClick={() => setSelectedTaskIds(allTaskIds)}>Выбрать все</button><button type="button" onClick={() => setSelectedTaskIds([])}>Снять выбор</button><Link to="/tasks">Добавить промпт</Link></div><div className="prompt-options">{tasks.data?.map((task) => <label key={task.id} className={selected.has(task.currentRevision.id) ? "selected" : ""}><input type="checkbox" checked={selected.has(task.currentRevision.id)} onChange={(event) => { const checked = event.currentTarget.checked; setSelectedTaskIds((current) => updateTaskSelection(current, task.currentRevision.id, checked)); }} /><span><strong>{task.currentRevision.name}</strong><small>{task.currentRevision.prompt}</small></span></label>)}</div>{!tasks.data?.length ? <p className="empty">Сначала добавьте промпт.</p> : null}</fieldset></div>
      <div className="launch-step" data-ready={Boolean(selectedRunner)}>
        <span>3</span>
        <div className="launch-fields">
          <fieldset className="result-mode">
            <legend>Что должна вернуть модель</legend>
            <label><input type="radio" name="resultMode" checked={resultMode === "text"} onChange={() => { setResultMode("text"); setRunnerOverride(""); }} />Текстовый ответ</label>
            <label><input type="radio" name="resultMode" checked={resultMode === "web"} onChange={() => { setResultMode("web"); setRunnerOverride(""); }} />Готовое web-приложение</label>
          </fieldset>
          {isLocalModel ? <fieldset className="result-mode">
            <legend>Среда локальной модели</legend>
            <label><input type="radio" name="localPromptMode" checked={!usingOmpAgent} onChange={() => { setUseOmpAgent(false); setRunnerOverride(""); }} />{resultMode === "web" ? "Без обвязки" : "Голая модель"}</label>
            <label><input type="radio" name="localPromptMode" checked={usingOmpAgent} onChange={() => { setUseOmpAgent(true); setRunnerOverride(""); }} disabled={!ompRunner || !selectedModel?.capabilities.toolUse} />OMP-среда</label>
          </fieldset> : null}
        </div>
        <span className="launch-mode-note">{usingOmpAgent
          ? "OMP: skills, расширения и настроенные MCP."
          : ompUnavailable
            ? ompUnavailable
          : resultMode === "web"
            ? "Изолированный OMP: без skills, расширений и MCP."
            : "Ответ модели без рабочей директории"}</span>
      </div>
      <details className="advanced"><summary>Дополнительные настройки</summary><label>Способ запуска<select value={runnerChoices.some((runner) => runner.id === runnerOverride) ? runnerOverride : ""} onChange={(event) => { const runner = runnerChoices.find((item) => item.id === event.currentTarget.value); setUseOmpAgent(isLocalModel && runner?.kind === "omp"); setRunnerOverride(event.currentTarget.value); }}><option value="">Автоматически: {automaticRunner?.name ?? "не определён"}</option>{runnerChoices.map((runner) => <option key={runner.id} value={runner.id}>{runner.name}</option>)}</select></label></details>
      <div className="launch-footer"><dl className="launch-summary" aria-label="Параметры запуска">{summary.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl><div className="launch-action"><div><strong>{selectedTasks.length ? promptCountLabel(selectedTasks.length) : "Выберите хотя бы один промпт"}</strong><small>{imageError ?? (selectedRunner ? `через ${selectedRunner.name}` : "Добавьте модель и промпт")}</small></div><button className="primary launch-button" onClick={() => launch.mutate()} disabled={launch.isPending || !selectedModel || !selectedTasks.length || !selectedRunner || Boolean(imageError)}>{launch.isPending ? "Создаём запуск…" : "Запустить"}<span>→</span></button></div></div>
      {launch.error ? <p className="error">{launch.error.message}</p> : null}
    </section>
    {active.length ? <Panel title="Сейчас выполняется" action={<Link to="/runs">Все результаты →</Link>}><div className="run-list">{active.map((run) => <Link className="run-row" key={run.id} to="/runs/$runId" params={{ runId: run.id }}><Status value={run.status} /><span className="run-row-copy"><strong>{models.data?.find((model) => model.id === run.model_id)?.name ?? "Модель"}</strong><small>{runners.data?.find((runner) => runner.id === run.runner_id)?.name ?? run.runner_id}</small></span><span className="run-row-score run-row-score-none">{run.status === "pending" ? "В очереди" : "Выполняется"}</span><time dateTime={run.created_at} title={new Date(run.created_at).toLocaleString("ru-RU")}>{new Date(run.created_at).toLocaleString("ru-RU")}</time></Link>)}</div></Panel> : null}
  </Page>;
}
