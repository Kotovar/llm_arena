import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api.js";
import { Empty, Page, Panel, useData } from "../shell.js";
import type { AppSettings, CalibrationResult, ExternalLauncher, LlamaParameters, LocalModelFile, Model, ModelCatalog, Profile, Runner } from "../types.js";
import { chooseRunner, defaultLocalProfile, formatDuration, latestProfiles } from "../ui.js";

export function ModelsPage() {
  const client = useQueryClient();
  const models = useData<Model[]>("models", "/models");
  const profiles = useData<Profile[]>("profiles", "/profiles");
  const runners = useData<Runner[]>("runners", "/runners");
  const catalog = useData<ModelCatalog>("model-catalog", "/model-catalog");
  const files = useData<LocalModelFile[]>("local-model-files", "/local-model-files");
  const settings = useData<AppSettings>("settings", "/settings");
  const [kind, setKind] = useState<"cloud" | "local-gguf">("local-gguf");
  const [profileMode, setProfileMode] = useState<"auto" | "manual">("auto");
  const [filename, setFilename] = useState("");
  const [localName, setLocalName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [cloudProvider, setCloudProvider] = useState<"anthropic" | "openai">("anthropic");
  const [cloudModelRef, setCloudModelRef] = useState("");
  const [diagnostics, setDiagnostics] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [hardware, setHardware] = useState<Record<string, CalibrationResult>>( {});

  const invalidateModels = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["models"] }),
      client.invalidateQueries({ queryKey: ["profiles"] }),
      client.invalidateQueries({ queryKey: ["local-model-files"] }),
    ]);
  };
  const createLocal = useMutation({
    mutationFn: (body: unknown) => api("/local-models", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      setFilename(""); setLocalName(""); setNameTouched(false);
      await invalidateModels();
    },
  });
  const createCloud = useMutation({
    mutationFn: (body: unknown) => api("/models", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => { setCloudModelRef(""); await invalidateModels(); },
  });
  const calibrate = useMutation({
    mutationFn: (id: string) => api<CalibrationResult>(`/profiles/${id}/calibrate`, { method: "POST" }),
    onSuccess: async (result, id) => { setHardware((current) => ({ ...current, [id]: result })); await client.invalidateQueries({ queryKey: ["profiles"] }); },
  });
  const activate = useMutation({
    mutationFn: ({ modelId, profileName }: { modelId: string; profileName: string }) => api<ExternalLauncher>("/external-launcher", { method: "PUT", body: JSON.stringify({ modelId, profileName, port: settings.data?.externalPort ?? 8080 }) }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["settings"] }),
  });
  const testModel = useMutation({
    mutationFn: ({ modelId, runnerId }: { modelId: string; runnerId: string }) => api<{ ok: boolean; answer: string; durationMs: number }>(`/models/${modelId}/test`, { method: "POST", body: JSON.stringify({ runnerId }) }),
    onSuccess: (result, variables) => setDiagnostics((current) => ({ ...current, [variables.modelId]: { ok: true, message: `Работает · ${formatDuration(result.durationMs)} · ${result.answer.slice(0, 80)}` } })),
    onError: (error, variables) => setDiagnostics((current) => ({ ...current, [variables.modelId]: { ok: false, message: error.message } })),
  });

  function submitLocal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const automatic = defaultLocalProfile("00000000-0000-0000-0000-000000000000").parameters;
    const gpuLayers = String(data.get("nGpuLayers") ?? "all").trim();
    const cpuMoe = String(data.get("nCpuMoe") ?? "").trim();
    const flash = String(data.get("flashAttention") ?? "auto");
    const manual: LlamaParameters = {
      context: Number(data.get("context")),
      nGpuLayers: gpuLayers === "all" ? "all" : Number(gpuLayers),
      ...(cpuMoe ? { nCpuMoe: Number(cpuMoe) } : {}),
      cacheTypeK: String(data.get("cacheTypeK")),
      cacheTypeV: String(data.get("cacheTypeV")),
      batchSize: Number(data.get("batchSize")),
      ubatchSize: Number(data.get("ubatchSize")),
      flashAttention: flash === "auto" ? "auto" : flash === "on",
      cacheReuse: Number(data.get("cacheReuse")),
      fit: false,
    };
    createLocal.mutate({ filename, name: localName, profileName: profileMode === "auto" ? "Automatic" : "Manual", profile: profileMode === "auto" ? automatic : manual });
  }

  function submitCloud(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    createCloud.mutate({ name: data.get("name"), kind: "cloud", provider: cloudProvider, modelRef: cloudModelRef });
  }

  const cloudOptions = cloudProvider === "anthropic" ? catalog.data?.claude.models ?? [] : catalog.data?.codex.models ?? [];
  const visibleProfiles = latestProfiles(profiles.data ?? []);
  return <Page title="Подключённые модели" eyebrow="Модели" intro="Локальные GGUF выбираются из доверенной папки. Автоматический профиль подгоняет загрузку под GPU через встроенный fit llama.cpp.">
    <div className="model-kind-tabs" role="group" aria-label="Тип подключения">
      <button className={kind === "local-gguf" ? "active" : ""} onClick={() => setKind("local-gguf")}>Локальные GGUF</button>
      <button className={kind === "cloud" ? "active" : ""} onClick={() => setKind("cloud")}>Облачные CLI</button>
    </div>
    <div className="two-col">
      <Panel title={kind === "local-gguf" ? "Добавить локальную модель" : "Добавить облачную модель"}>
        {kind === "local-gguf" ? <form onSubmit={submitLocal} className="form-grid">
          <label className="span-2">GGUF-файл
            <select value={filename} onChange={(event) => { const next = event.currentTarget.value; setFilename(next); if (!nameTouched) setLocalName(next.replace(/\.gguf$/iu, "")); }} required>
              <option value="">Выберите файл из {settings.data?.modelDirectory ?? "каталога моделей"}</option>
              {files.data?.map((file) => <option key={file.filename} value={file.filename} disabled={Boolean(file.connectedModelId)}>{file.filename}{file.connectedModelId ? " · уже подключена" : ` · ${(file.sizeBytes / 1024 ** 3).toFixed(1)} GiB`}</option>)}
            </select>
            <small>Путь не вводится вручную: сервер проверяет файл и не разрешает выход из настроенной папки.</small>
          </label>
          <label className="span-2">Название в результатах<input value={localName} onChange={(event) => { setLocalName(event.currentTarget.value); setNameTouched(true); }} placeholder="Например, Gemma 4 E4B" required /></label>
          <fieldset className="profile-mode span-2"><legend>Профиль запуска</legend>
            <label className={profileMode === "auto" ? "selected" : ""}><input type="radio" checked={profileMode === "auto"} onChange={() => setProfileMode("auto")} /><strong>Автоматически</strong><small>Максимум GPU с резервом 750 MiB, контекст не ниже 4096, Flash Attention и GPU-слои подбирает llama.cpp.</small></label>
            <label className={profileMode === "manual" ? "selected" : ""}><input type="radio" checked={profileMode === "manual"} onChange={() => setProfileMode("manual")} /><strong>Вручную</strong><small>Точные параметры для сравнения или переноса в другую связку.</small></label>
          </fieldset>
          {profileMode === "manual" ? <details className="manual-profile span-2" open><summary>Ручные параметры llama.cpp</summary><div className="form-grid">
            <label>Контекст<input name="context" type="number" min="1024" step="1024" defaultValue="32768" required /><small>Размер контекста в токенах. Больше — выше расход VRAM.</small></label>
            <label>GPU-слои<input name="nGpuLayers" defaultValue="all" pattern="all|[0-9]+" required /><small><code>all</code> — все возможные, либо точное число.</small></label>
            <label>MoE-слои на CPU<input name="nCpuMoe" type="number" min="0" placeholder="не задавать" /><small>Только для MoE. Чем больше, тем меньше VRAM и ниже скорость.</small></label>
            <label>Flash Attention<select name="flashAttention" defaultValue="auto"><option value="auto">Автоматически</option><option value="on">Включить</option><option value="off">Выключить</option></select></label>
            <label>K-cache<select name="cacheTypeK" defaultValue="q8_0"><option>q8_0</option><option>q4_0</option><option>f16</option></select><small>q8_0 — качественный баланс памяти.</small></label>
            <label>V-cache<select name="cacheTypeV" defaultValue="q8_0"><option>q8_0</option><option>q4_0</option><option>f16</option></select></label>
            <label>Batch<input name="batchSize" type="number" min="1" defaultValue="1024" required /><small>Логический размер обработки промпта.</small></label>
            <label>Micro-batch<input name="ubatchSize" type="number" min="1" defaultValue="512" required /><small>Физический пакет; уменьшите при нехватке VRAM.</small></label>
            <label>Повторное использование KV<input name="cacheReuse" type="number" min="0" defaultValue="256" required /><small>Сколько токенов кеша пытаться переиспользовать.</small></label>
          </div></details> : null}
          <button className="primary span-2" disabled={createLocal.isPending || !filename}>{createLocal.isPending ? "Подключаем…" : "Подключить модель"}</button>
          {files.error ? <p className="error span-2">Не удалось прочитать папку: {files.error.message}. Изменить путь можно в Настройках.</p> : null}
          {files.data && !files.data.length ? <p className="empty span-2">В папке нет GGUF-файлов.</p> : null}
          {createLocal.error ? <p className="error span-2">{createLocal.error.message}</p> : null}
        </form> : <form onSubmit={submitCloud} className="form-grid">
          <label>Название<input name="name" required /></label>
          <label>Провайдер<select value={cloudProvider} onChange={(event) => { setCloudProvider(event.target.value as typeof cloudProvider); setCloudModelRef(""); }}><option value="anthropic">Claude Code</option><option value="openai">Codex CLI</option></select></label>
          <label className="span-2">Модель<input list="cloud-models" value={cloudModelRef} onChange={(event) => setCloudModelRef(event.target.value)} required /><datalist id="cloud-models">{cloudOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</datalist><small>Можно выбрать найденную модель или ввести полный ID.</small></label>
          <button className="primary" disabled={createCloud.isPending}>{createCloud.isPending ? "Подключаем…" : "Подключить"}</button>{createCloud.error ? <p className="error">{createCloud.error.message}</p> : null}
        </form>}
      </Panel>
      <Panel title={`Подключено: ${models.data?.length ?? 0}`}><div className="stack">{models.data?.map((model) => {
        const runner = chooseRunner(model, ["prompt"], runners.data ?? []);
        const checking = testModel.isPending && testModel.variables?.modelId === model.id;
        const modelProfiles = visibleProfiles.filter((profile) => profile.modelId === model.id);
        return <details className="model-card" key={model.id}><summary className="model-card-summary"><span className="model-card-copy"><span className="mono">{model.kind === "local-gguf" ? "Локальная GGUF" : "Облачная CLI"} · {model.provider}</span><strong>{model.name}</strong><span>{model.kind === "local-gguf" ? model.path?.split("/").at(-1) : model.modelRef}</span></span><span className="model-card-state">{settings.data?.externalModelId === model.id ? <span className="chip active-chip">Активна для omp-local</span> : null}<span className="expand-label">Настройки</span></span></summary><div className="model-card-content">
          {diagnostics[model.id] ? <p className={diagnostics[model.id]?.ok ? "success" : "error"}>{diagnostics[model.id]?.message}</p> : null}
          {modelProfiles.map((profile) => { const report = hardware[profile.id]; const isActive = settings.data?.externalModelId === model.id && settings.data.externalProfileName === profile.name; return <section className="profile-card" key={profile.id}>
            <div className="profile-heading"><div><strong>{profile.name}</strong><span>версия {profile.revision}{profile.calibrated ? " · проверена" : ""}</span></div>{isActive ? <span className="status status-completed">Для omp-local</span> : null}</div>
            <dl className="profile-summary"><div><dt>Контекст</dt><dd>{String(profile.parameters.context)}</dd></div><div><dt>GPU-слои</dt><dd>{String(profile.parameters.nGpuLayers)}</dd></div><div><dt>KV cache</dt><dd>{profile.parameters.cacheTypeK} / {profile.parameters.cacheTypeV}</dd></div><div><dt>Batch</dt><dd>{profile.parameters.batchSize} / {profile.parameters.ubatchSize}</dd></div><div><dt>Fit</dt><dd>{profile.parameters.fit ? `${profile.parameters.fitTargetMiB} MiB · min ${profile.parameters.fitContextMin}` : "выключен"}</dd></div></dl>
            {report ? <div className="gpu-report"><strong>{report.gpu.name}</strong><span>VRAM: {report.gpu.usedMiB} MiB занято · {report.gpu.freeMiB} MiB свободно из {report.gpu.totalMiB} MiB</span></div> : null}
            {calibrate.error && calibrate.variables === profile.id ? <p className="error">{calibrate.error.message}</p> : null}
            {activate.error && activate.variables?.modelId === model.id && activate.variables.profileName === profile.name ? <p className="error">{activate.error.message}</p> : null}
            <div className="model-toolbar"><button onClick={() => calibrate.mutate(profile.id)} disabled={calibrate.isPending}>{calibrate.isPending && calibrate.variables === profile.id ? "Запускаем и проверяем…" : "Проверить автоконфигурацию"}</button><button className="primary" onClick={() => activate.mutate({ modelId: model.id, profileName: profile.name })} disabled={activate.isPending}>{activate.isPending && activate.variables?.modelId === model.id ? "Настраиваем omp-local…" : "Использовать с omp-local"}</button></div>
          </section>; })}
          <div className="model-toolbar"><button onClick={() => runner && testModel.mutate({ modelId: model.id, runnerId: runner.id })} disabled={!runner || checking}>{checking ? "Проверяем ответ…" : "Проверить модель"}</button><small>{runner ? `через ${runner.name}` : "Нет подходящего runner"}</small></div>
        </div></details>;
      })}{!models.data?.length ? <Empty>Пока нет подключённых моделей.</Empty> : null}</div></Panel>
    </div>
  </Page>;
}
