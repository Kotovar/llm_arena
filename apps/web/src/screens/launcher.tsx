import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Page, Panel, Status, useData } from "../shell.js";
import type { Benchmark, Model, ModelCatalog, Profile, Run, Runner, Task } from "../types.js";
import { chooseRunner, initializeTaskSelection, latestProfiles, modelOptionLabel, reasoningEffortsForModel, updateTaskSelection } from "../ui.js";

export function Launcher() {
  const tasks = useData<Task[]>("tasks", "/tasks");
  const models = useData<Model[]>("models", "/models");
  const profiles = useData<Profile[]>("profiles", "/profiles");
  const runners = useData<Runner[]>("runners", "/runners");
  const catalog = useData<ModelCatalog>("model-catalog", "/model-catalog");
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: 1_000 });
  const navigate = useNavigate();
  const [modelId, setModelId] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[] | null>(null);
  const [resultMode, setResultMode] = useState<"text" | "web">("text");
  const [runnerOverride, setRunnerOverride] = useState("");
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
  const automaticRunner = selectedModel ? chooseRunner(selectedModel, [resultMode === "web" ? "coding" : "prompt"], runners.data ?? []) : undefined;
  const selectedRunner = runners.data?.find((runner) => runner.id === runnerOverride) ?? automaticRunner;
  const providerCatalog = selectedModel?.provider.toLowerCase().includes("anthropic") ? catalog.data?.claude : selectedModel?.provider.toLowerCase().includes("openai") ? catalog.data?.codex : undefined;
  const effectiveModelRef = selectedModel?.kind === "cloud" ? cloudModelRef || selectedModel.modelRef : selectedModel?.modelRef ?? "";
  const modelOption = providerCatalog?.models.find((option) => option.id === effectiveModelRef);
  const reasoningOptions = reasoningEffortsForModel(selectedModel?.kind, modelOption?.efforts);
  const effectiveEffort = reasoningEffort || modelOption?.defaultEffort || "";
  const launch = useMutation({
    mutationFn: async () => {
      if (!selectedModel || !selectedRunner || !selectedTasks.length) throw new Error("Выберите модель и хотя бы один промпт");
      const benchmark = await api<Benchmark>("/benchmarks", { method: "POST", body: JSON.stringify({
        name: selectedTasks.length === 1 ? selectedTasks[0]!.currentRevision.name : `${selectedTasks.length} промптов · ${new Date().toLocaleString("ru-RU")}`,
        taskRevisionIds: selectedTasks.map((task) => task.currentRevision.id),
      }) });
      const profile = latestProfiles(profiles.data ?? []).find((item) => item.modelId === selectedModel.id);
      return api<Run>("/runs", { method: "POST", body: JSON.stringify({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: selectedModel.id, executionProfileId: profile?.id ?? null, runnerId: selectedRunner.id, resultMode, modelRef: selectedModel.kind === "cloud" ? effectiveModelRef : undefined, reasoningEffort: effectiveEffort || null }) });
    },
    onSuccess: (run) => navigate({ to: "/runs/$runId", params: { runId: run.id } }),
  });
  const allTaskIds = tasks.data?.map((task) => task.currentRevision.id) ?? [];

  return <Page title="Запустить проверку модели" eyebrow="Новый запуск" intro="Выберите модель, один или несколько промптов. Остальные параметры приложение подберёт автоматически.">
    <section className="launch-card">
      <div className="launch-step"><span>1</span><div className="launch-fields"><label>Подключение<select value={selectedModelId} onChange={(event) => { setModelId(event.currentTarget.value); setCloudModelRef(""); setRunnerOverride(""); setReasoningEffort(""); }} disabled={!models.data?.length}><option value="">Выберите модель</option>{models.data?.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.provider}</option>)}</select></label>{selectedModel?.kind === "cloud" ? <label>Конкретная модель<select value={effectiveModelRef} onChange={(event) => { setCloudModelRef(event.currentTarget.value); setReasoningEffort(""); }}>{!providerCatalog?.models.some((option) => option.id === selectedModel.modelRef) ? <option value={selectedModel.modelRef}>{selectedModel.modelRef}</option> : null}{providerCatalog?.models.map((option) => <option key={option.id} value={option.id}>{modelOptionLabel(option)}</option>)}</select></label> : null}{reasoningOptions.length ? <label>Уровень обдумывания<select value={effectiveEffort} onChange={(event) => setReasoningEffort(event.currentTarget.value)}><option value="">По умолчанию</option>{reasoningOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select>{selectedModel?.kind === "local-gguf" ? <small>Доступность зависит от chat template модели.</small> : null}</label> : null}</div><Link to="/models">Подключить модель</Link></div>
      <div className="launch-step prompt-step"><span>2</span><fieldset className="prompt-picker"><legend><strong>Какие промпты запустить</strong><small>{selectedTasks.length} из {tasks.data?.length ?? 0}</small></legend><div className="picker-actions"><button type="button" onClick={() => setSelectedTaskIds(allTaskIds)}>Выбрать все</button><button type="button" onClick={() => setSelectedTaskIds([])}>Снять выбор</button><Link to="/tasks">Добавить промпт</Link></div><div className="prompt-options">{tasks.data?.map((task) => <label key={task.id} className={selected.has(task.currentRevision.id) ? "selected" : ""}><input type="checkbox" checked={selected.has(task.currentRevision.id)} onChange={(event) => { const checked = event.currentTarget.checked; setSelectedTaskIds((current) => updateTaskSelection(current, task.currentRevision.id, checked)); }} /><span><strong>{task.currentRevision.name}</strong><small>{task.currentRevision.prompt}</small></span></label>)}</div>{!tasks.data?.length ? <p className="empty">Сначала добавьте промпт.</p> : null}</fieldset></div>
      <div className="launch-step"><span>3</span><fieldset className="result-mode"><legend>Что должна вернуть модель</legend><label><input type="radio" name="resultMode" checked={resultMode === "text"} onChange={() => { setResultMode("text"); setRunnerOverride(""); }} />Текстовый ответ</label><label><input type="radio" name="resultMode" checked={resultMode === "web"} onChange={() => { setResultMode("web"); setRunnerOverride(""); }} />Готовое web-приложение</label></fieldset><span className="launch-mode-note">{resultMode === "web" ? "Будут созданы файлы и Preview" : "Ответ модели без рабочей директории"}</span></div>
      <details className="advanced"><summary>Дополнительные настройки</summary><label>Способ запуска<select value={runnerOverride} onChange={(event) => setRunnerOverride(event.currentTarget.value)}><option value="">Автоматически: {automaticRunner?.name ?? "не определён"}</option>{runners.data?.map((runner) => <option key={runner.id} value={runner.id}>{runner.name}</option>)}</select></label></details>
      <div className="launch-footer"><div><strong>{selectedTasks.length ? `${selectedTasks.length} ${selectedTasks.length === 1 ? "промпт" : "промптов"}` : "Выберите хотя бы один промпт"}</strong><small>{selectedRunner ? `через ${selectedRunner.name}` : "Добавьте модель и промпт"}</small></div><button className="primary launch-button" onClick={() => launch.mutate()} disabled={launch.isPending || !selectedModel || !selectedTasks.length || !selectedRunner}>{launch.isPending ? "Создаём запуск…" : "Запустить"}<span>→</span></button></div>
      {launch.error ? <p className="error">{launch.error.message}</p> : null}
    </section>
    {active.length ? <Panel title="Сейчас выполняется" action={<Link to="/runs">Все результаты →</Link>}><div className="run-list">{active.map((run) => <Link className="run-row" key={run.id} to="/runs/$runId" params={{ runId: run.id }}><Status value={run.status} /><strong>{models.data?.find((model) => model.id === run.model_id)?.name ?? "Модель"}</strong><span>{run.runner_id}</span><time>{new Date(run.created_at).toLocaleString("ru-RU")}</time><span>→</span></Link>)}</div></Panel> : null}
  </Page>;
}
