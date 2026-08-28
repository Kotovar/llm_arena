import { DEFAULT_LLAMA_TEMPERATURE } from "@llm-arena/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api.js";
import { useConfirm } from "../confirm.js";
import { Empty, Page, Panel, useData } from "../shell.js";
import { useToast } from "../toast.js";
import type { AppSettings, CalibrationResult, ExternalLauncher, LlamaParameters, LocalModelFile, Model, ModelCatalog, Profile, Runner } from "../types.js";
import { chooseRunner, defaultLocalProfile, formatDuration, latestProfiles, visionProjectorFiles } from "../ui.js";

type Capabilities = Model["capabilities"];

/** Компактная подпись к GGUF: размер файла и тип архитектуры. */
export function ggufSummary(sizeBytes?: number, expertCount?: number): string {
  const parts: string[] = [];
  if (sizeBytes) parts.push(`${(sizeBytes / 1024 ** 3).toFixed(1)} GiB`);
  if (expertCount !== undefined) parts.push(expertCount > 0 ? `MoE, ${expertCount} экспертов` : "dense");
  return parts.join(" · ");
}

export function moveModel<T extends { id: string }>(models: readonly T[], modelId: string, targetId: string): T[] {
  const source = models.findIndex((model) => model.id === modelId);
  const target = models.findIndex((model) => model.id === targetId);
  if (source < 0 || target < 0 || source === target) return [...models];
  const next = [...models];
  const [model] = next.splice(source, 1);
  next.splice(next.findIndex((item) => item.id === targetId), 0, model!);
  return next;
}

function CapabilityCheckboxes({ value, onChange }: { value: Capabilities; onChange: (value: Capabilities) => void }) {
  return <div className="capability-options">
    <label><input type="checkbox" checked={value.toolUse} onChange={(event) => onChange({ ...value, toolUse: event.currentTarget.checked })} />Tools<small>Можно запускать через OMP-среду с инструментами.</small></label>
    <label><input type="checkbox" checked={value.vision} onChange={(event) => onChange({ ...value, vision: event.currentTarget.checked })} />Vision<small>Принимает прикреплённые изображения.</small></label>
    <label><input type="checkbox" checked={value.reasoning} onChange={(event) => onChange({ ...value, reasoning: event.currentTarget.checked })} />Reasoning<small>Позволяет выбрать уровень обдумывания.</small></label>
  </div>;
}

function ModelCapabilitiesForm({ model, files, pending, save }: { model: Model; files: LocalModelFile[]; pending: boolean; save: (input: { modelId: string; capabilities: Capabilities; mmprojFilename: string | null }) => void }) {
  const [capabilities, setCapabilities] = useState(model.capabilities);
  const [mmprojFilename, setMmprojFilename] = useState(model.mmprojPath?.split("/").at(-1) ?? "");
  return <form className="capabilities-form" onSubmit={(event) => { event.preventDefault(); save({ modelId: model.id, capabilities, mmprojFilename: model.kind === "local-gguf" && capabilities.vision ? mmprojFilename || null : null }); }}>
    <fieldset className="capability-fieldset"><legend>Возможности модели</legend>
      <CapabilityCheckboxes value={capabilities} onChange={setCapabilities} />
      {model.kind === "local-gguf" && capabilities.vision ? <label>Vision-проектор <code>mmproj</code>
        <select value={mmprojFilename} onChange={(event) => setMmprojFilename(event.currentTarget.value)} required>
          <option value="">Выберите отдельный файл mmproj</option>
          {visionProjectorFiles(files).map((file) => <option key={file.filename} value={file.filename}>{file.filename}</option>)}
        </select>
        <small>Это отдельный GGUF-файл для обработки изображений, не основная модель. llama.cpp получит его через <code>--mmproj</code>.</small>
      </label> : null}
    </fieldset>
    <button className="primary" disabled={pending || (model.kind === "local-gguf" && capabilities.vision && !mmprojFilename)}>{pending ? "Сохраняем возможности…" : "Сохранить возможности"}</button>
  </form>;
}

function NewProfileForm({ modelId, source, pending, create }: { modelId: string; source: Profile; pending: boolean; create: (input: { modelId: string; name: string; parameters: LlamaParameters }) => Promise<Profile> }) {
  const [open, setOpen] = useState(false);
  return <details className="manual-profile" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Добавить профиль</summary><form className="form-grid" onSubmit={(event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(event.currentTarget);
    const contextValue = String(data.get("context") ?? "auto").trim();
    const gpuLayersValue = String(data.get("nGpuLayers") ?? "auto").trim();
    const cpuMoe = String(data.get("nCpuMoe") ?? "").trim();
    const context: LlamaParameters["context"] = contextValue === "auto" ? "auto" : Number(contextValue);
    const nGpuLayers: LlamaParameters["nGpuLayers"] = gpuLayersValue === "auto" ? "auto" : gpuLayersValue === "all" ? "all" : Number(gpuLayersValue);
    void create({ modelId, name: String(data.get("profileName") ?? ""), parameters: {
      context,
      nGpuLayers,
      ...(cpuMoe ? { nCpuMoe: Number(cpuMoe) } : {}),
      cacheTypeK: String(data.get("cacheTypeK")),
      cacheTypeV: String(data.get("cacheTypeV")),
      batchSize: Number(data.get("batchSize")),
      ubatchSize: Number(data.get("ubatchSize")),
      flashAttention: String(data.get("flashAttention")) === "auto" ? "auto" : String(data.get("flashAttention")) === "on",
      cacheReuse: Number(data.get("cacheReuse")),
      fit: data.get("fit") === "on",
      ...(data.get("fit") === "on" ? { fitTargetMiB: Number(data.get("fitTargetMiB")), fitContextMin: Number(data.get("fitContextMin")) } : {}),
      temperature: Number(data.get("temperature")),
      // Пустой seed — это «пусть llama.cpp выберет сам», а не ноль.
      ...(String(data.get("seed") ?? "").trim() ? { seed: Number(data.get("seed")) } : {}),
    } }).then(() => { form.reset(); setOpen(false); }).catch(() => undefined);
  }}>
    <label className="span-2">Название профиля<input name="profileName" placeholder="Например, Скорость 32k" required /><small>Отдельное имя создаёт вариант для выбора при запуске; изменение существующего имени создаёт новую ревизию.</small></label>
    <label>Контекст, токенов<input name="context" defaultValue={source.parameters.context} pattern="auto|[0-9]+" required /></label>
    <label>GPU-слои<input name="nGpuLayers" defaultValue={source.parameters.nGpuLayers} pattern="auto|all|[0-9]+" required /></label>
    <label>Точность K-кеша<select name="cacheTypeK" defaultValue={source.parameters.cacheTypeK}><option>q8_0</option><option>q4_0</option><option>f16</option></select></label>
    <label>Точность V-кеша<select name="cacheTypeV" defaultValue={source.parameters.cacheTypeV}><option>q8_0</option><option>q4_0</option><option>f16</option></select></label>
    <label>Batch<input name="batchSize" type="number" min="1" defaultValue={source.parameters.batchSize} required /></label>
    <label>Micro-batch<input name="ubatchSize" type="number" min="1" defaultValue={source.parameters.ubatchSize} required /></label>
    <label>Flash Attention<select name="flashAttention" defaultValue={source.parameters.flashAttention === "auto" ? "auto" : source.parameters.flashAttention ? "on" : "off"}><option value="auto">Автоматически</option><option value="on">Включить</option><option value="off">Выключить</option></select></label>
    <label>Переиспользование KV<input name="cacheReuse" type="number" min="0" defaultValue={source.parameters.cacheReuse} required /></label>
    <label>Эксперты на CPU<input name="nCpuMoe" type="number" min="0" defaultValue={source.parameters.nCpuMoe ?? ""} placeholder="не переносить" /></label>
    <label><input name="fit" type="checkbox" defaultChecked={source.parameters.fit} />Автоподбор загрузки</label>
    <label>Резерв VRAM, MiB<input name="fitTargetMiB" type="number" min="1" defaultValue={source.parameters.fitTargetMiB ?? 750} required /></label>
    <label>Минимальный контекст<input name="fitContextMin" type="number" min="4096" defaultValue={source.parameters.fitContextMin ?? 100000} required /></label>
    <label>Температура<input name="temperature" type="number" min="0" max="2" step="0.05" defaultValue={source.parameters.temperature ?? DEFAULT_LLAMA_TEMPERATURE} required /></label>
    <label>Seed<input name="seed" type="number" defaultValue={source.parameters.seed ?? ""} placeholder="случайный" /></label>
    <button className="primary" disabled={pending}>{pending ? "Создаём профиль…" : "Создать профиль"}</button>
  </form></details>;
}

export function ModelsPage() {
  const client = useQueryClient();
  const { confirm, view: confirmView } = useConfirm();
  const toast = useToast();
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
  const [cloudProvider, setCloudProvider] = useState<"anthropic" | "openai" | "opencode">("anthropic");
  const [cloudModelRef, setCloudModelRef] = useState("");
  const [localCapabilities, setLocalCapabilities] = useState<Capabilities>({ toolUse: false, vision: false, reasoning: false });
  const [localMmprojFilename, setLocalMmprojFilename] = useState("");
  const [diagnostics, setDiagnostics] = useState<Record<string, { ok: boolean; title: string; detail: string }>>({});
  const [hardware, setHardware] = useState<Record<string, CalibrationResult>>( {});
  const [draggedModelId, setDraggedModelId] = useState<string | null>(null);
  // Карточка перетаскивается только за ручку: иначе выделение текста и клик по полям внутри
  // превращаются в перетаскивание.
  const [handleModelId, setHandleModelId] = useState<string | null>(null);

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
      setFilename(""); setLocalName(""); setNameTouched(false); setLocalCapabilities({ toolUse: false, vision: false, reasoning: false }); setLocalMmprojFilename("");
      await invalidateModels();
    },
  });
  const createCloud = useMutation({
    mutationFn: (body: unknown) => api("/models", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => { setCloudModelRef(""); await invalidateModels(); },
  });
  const createProfile = useMutation({
    mutationFn: (body: { modelId: string; name: string; parameters: LlamaParameters }) => api<Profile>("/profiles", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async (profile) => { toast(`Профиль «${profile.name}» создан.`); await client.invalidateQueries({ queryKey: ["profiles"] }); },
  });
  const deleteProfile = useMutation({
    mutationFn: (profile: Profile) => api(`/profiles/${profile.id}`, { method: "DELETE" }),
    onSuccess: async (_, profile) => { toast(`Профиль «${profile.name}» удалён.`); await client.invalidateQueries({ queryKey: ["profiles"] }); },
  });
  const calibrate = useMutation({
    mutationFn: (id: string) => api<CalibrationResult>(`/profiles/${id}/calibrate`, { method: "POST" }),
    onSuccess: async (result, id) => { setHardware((current) => ({ ...current, [id]: result })); await client.invalidateQueries({ queryKey: ["profiles"] }); },
  });
  const activate = useMutation({
    mutationFn: ({ modelId, profileName }: { modelId: string; profileName: string }) => api<ExternalLauncher>("/external-launcher", { method: "PUT", body: JSON.stringify({ modelId, profileName, port: settings.data?.externalPort ?? 8080 }) }),
    onSuccess: async () => client.invalidateQueries({ queryKey: ["settings"] }),
  });
  const disconnect = useMutation({
    mutationFn: (modelId: string) => api(`/models/${modelId}`, { method: "DELETE" }),
    onSuccess: async () => { await invalidateModels(); await client.invalidateQueries({ queryKey: ["settings"] }); },
  });
  const rename = useMutation({
    mutationFn: ({ modelId, name }: { modelId: string; name: string }) => api(`/models/${modelId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: invalidateModels,
  });
  const saveEconomics = useMutation({
    mutationFn: ({ modelId, economics }: { modelId: string; economics: Model["economics"] }) => api(`/models/${modelId}/economics`, { method: "PUT", body: JSON.stringify({ economics }) }),
    onSuccess: async (_result, variables) => {
      toast(variables.economics ? `Цена прогона: ≈ $${(variables.economics.monthlyCost / variables.economics.includedRunEstimate).toFixed(2)}` : "Цену прогона больше не показываем");
      await invalidateModels();
    },
    onError: (error) => toast(error.message, "error"),
  });
  const reorder = useMutation({
    mutationFn: (modelIds: string[]) => api<Model[]>("/models/order", { method: "PUT", body: JSON.stringify({ modelIds }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["models"] }),
  });
  const saveCapabilities = useMutation({
    mutationFn: ({ modelId, capabilities, mmprojFilename }: { modelId: string; capabilities: Capabilities; mmprojFilename: string | null }) => api(`/models/${modelId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities, mmprojFilename }) }),
    onSuccess: invalidateModels,
  });
  const testModel = useMutation({
    mutationFn: ({ modelId, runnerId }: { modelId: string; runnerId: string }) => api<{ ok: boolean; answer: string; durationMs: number }>(`/models/${modelId}/test`, { method: "POST", body: JSON.stringify({ runnerId }) }),
    onSuccess: (result, variables) => setDiagnostics((current) => ({ ...current, [variables.modelId]: { ok: true, title: `Отвечает · ${formatDuration(result.durationMs)}`, detail: result.answer.slice(0, 200) } })),
    onError: (error, variables) => setDiagnostics((current) => ({ ...current, [variables.modelId]: { ok: false, title: "Не отвечает", detail: error.message } })),
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
    // Сэмплинг — свойство профиля независимо от того, автоматический он или ручной.
    const sampling = {
      temperature: Number(data.get("temperature") ?? DEFAULT_LLAMA_TEMPERATURE),
      ...(String(data.get("seed") ?? "").trim() ? { seed: Number(data.get("seed")) } : {}),
    };
    createLocal.mutate({ filename, name: localName, profileName: profileMode === "auto" ? "Automatic" : "Manual", profile: { ...(profileMode === "auto" ? automatic : manual), ...sampling }, capabilities: localCapabilities, mmprojFilename: localCapabilities.vision ? localMmprojFilename || null : null });
  }

  function submitCloud(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    createCloud.mutate({ name: data.get("name"), kind: "cloud", provider: cloudProvider, modelRef: cloudModelRef });
  }

  function submitEconomics(event: FormEvent<HTMLFormElement>, modelId: string) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const monthlyCost = Number(data.get("monthlyCost"));
    const includedRunEstimate = Number(data.get("includedRunEstimate"));
    // Половины оценки не бывает: пустые поля — это «цену не считаем», а не ноль.
    const economics = monthlyCost > 0 && includedRunEstimate > 0 ? { monthlyCost, includedRunEstimate } : null;
    saveEconomics.mutate({ modelId, economics });
  }

  function submitRename(event: FormEvent<HTMLFormElement>, modelId: string) {
    event.preventDefault();
    rename.mutate({ modelId, name: String(new FormData(event.currentTarget).get("name") ?? "") });
  }

  const cloudOptions = cloudProvider === "anthropic" ? catalog.data?.claude.models ?? [] : cloudProvider === "openai" ? catalog.data?.codex.models ?? [] : [];
  const visibleProfiles = latestProfiles(profiles.data ?? []);
  return <Page title="Подключённые модели" eyebrow="Модели" intro="Локальные GGUF берутся из доверенной папки. Автопрофиль сам подбирает загрузку под вашу GPU.">
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
              {files.data?.map((file) => <option key={file.filename} value={file.filename} disabled={Boolean(file.connectedModelId)}>{file.filename} · {ggufSummary(file.sizeBytes, file.expertCount)}{file.connectedModelId ? " · уже подключена" : ""}</option>)}
            </select>
            <small>Путь не вводится вручную: сервер проверяет файл и не разрешает выход из настроенной папки.</small>
          </label>
          <label className="span-2">Название в результатах<input value={localName} onChange={(event) => { setLocalName(event.currentTarget.value); setNameTouched(true); }} placeholder="Например, Gemma 4 E4B" required /></label>
          <fieldset className="capability-fieldset span-2"><legend>Возможности модели</legend>
            <CapabilityCheckboxes value={localCapabilities} onChange={setLocalCapabilities} />
            {localCapabilities.vision ? <label>Vision-проектор <code>mmproj</code>
              <select value={localMmprojFilename} onChange={(event) => setLocalMmprojFilename(event.currentTarget.value)} required>
                <option value="">Выберите отдельный файл mmproj</option>
                {visionProjectorFiles(files.data ?? []).map((file) => <option key={file.filename} value={file.filename}>{file.filename}</option>)}
              </select>
              <small>Это отдельный GGUF-файл для обработки изображений, не повторный выбор основной модели.</small>
            </label> : null}
          </fieldset>
          <fieldset className="profile-mode span-2"><legend>Профиль запуска</legend>
            <label className={profileMode === "auto" ? "selected" : ""}><input type="radio" checked={profileMode === "auto"} onChange={() => setProfileMode("auto")} /><strong>Автоматически</strong><small>Максимум GPU с резервом 750 MiB, контекст не ниже 100 000, Flash Attention и GPU-слои подбирает llama.cpp.</small></label>
            <label className={profileMode === "manual" ? "selected" : ""}><input type="radio" checked={profileMode === "manual"} onChange={() => setProfileMode("manual")} /><strong>Вручную</strong><small>Точные параметры для сравнения или переноса в другую связку.</small></label>
          </fieldset>
          <fieldset className="sampling-fields span-2"><legend>Сэмплинг</legend>
            <label>Температура<input name="temperature" type="number" min="0" max="2" step="0.05" defaultValue={DEFAULT_LLAMA_TEMPERATURE} required /><small>Насколько модель отходит от самого вероятного продолжения. Ниже — стабильнее и повторяемее, выше — разнообразнее.</small></label>
            <label>Seed<input name="seed" type="number" placeholder="случайный" /><small>Фиксирует случайность генерации: с одинаковым seed и температурой прогон повторяем. Пусто — llama.cpp выбирает сам.</small></label>
          </fieldset>
          {profileMode === "manual" ? <details className="manual-profile span-2" open><summary>Ручные параметры llama.cpp</summary>
            <p className="type-hint">Не хватает VRAM? Понижайте по порядку: точность KV-кеша до <code>q4_0</code>, затем micro-batch, затем контекст. Слои на CPU трогайте последними — они сильнее всего бьют по скорости.</p>
            <div className="form-grid">
            <label>Контекст, токенов<input name="context" type="number" min="4096" step="1024" defaultValue="100000" required /><small>Сколько текста модель удерживает за один запуск. Больше контекст — больше VRAM под кеш, и на MoE-модели больше экспертов уезжает в оперативную память. Контекст ниже примерно 32k заметно ускоряет генерацию.</small></label>
            <label>Слои на видеокарте<input name="nGpuLayers" defaultValue="all" pattern="all|[0-9]+" required /><small><code>all</code> — вся модель в VRAM, самый быстрый вариант. Число — столько слоёв на GPU, остальное считает процессор: влезет в память, но медленнее.</small></label>
            <label>Точность K-кеша<select name="cacheTypeK" defaultValue="q8_0"><option>q8_0</option><option>q4_0</option><option>f16</option></select><small>KV-кеш — это память внимания, после весов он главный потребитель VRAM. <code>q8_0</code> — вдвое меньше <code>f16</code> почти без потерь, обычно лучший выбор: на MoE освободившаяся VRAM уходит под эксперты и ускоряет генерацию.</small></label>
            <label>Точность V-кеша<select name="cacheTypeV" defaultValue="q8_0"><option>q8_0</option><option>q4_0</option><option>f16</option></select><small>Вторая половина того же кеша. Держите наравне с K; <code>q4_0</code> экономит ещё вдвое, но на длинном контексте ответы могут поплыть.</small></label>
            <label>Micro-batch<input name="ubatchSize" type="number" min="1" defaultValue="512" required /><small>Сколько токенов промпта считается за один физический проход. Это пиковый расход VRAM при чтении промпта — уменьшайте первым при нехватке памяти.</small></label>
            <label>Batch<input name="batchSize" type="number" min="1" defaultValue="1024" required /><small>Логический размер порции промпта, кратный micro-batch. На память влияет слабо, на скорость чтения — заметно.</small></label>
            <label>Flash Attention<select name="flashAttention" defaultValue="auto"><option value="auto">Автоматически</option><option value="on">Включить</option><option value="off">Выключить</option></select><small>Экономный алгоритм внимания: быстрее и меньше памяти на длинном контексте. «Автоматически» — решает llama.cpp по вашей видеокарте.</small></label>
            <label>Переиспользование KV, токенов<input name="cacheReuse" type="number" min="0" defaultValue="256" required /><small>Сколько токенов из прошлого запроса брать из кеша вместо повторного расчёта. Ускоряет уточнения, <code>0</code> — считать каждый раз заново.</small></label>
            <label>Экспертные слои на CPU<input name="nCpuMoe" type="number" min="0" placeholder="не переносить" /><small>Только для MoE-моделей. Переносит часть экспертов в оперативную память: освобождает VRAM ценой скорости. Пусто — всё на видеокарте.</small></label>
          </div></details> : null}
          <button className="primary span-2" disabled={createLocal.isPending || !filename || (localCapabilities.vision && !localMmprojFilename)}>{createLocal.isPending ? "Подключаем…" : "Подключить модель"}</button>
          {files.error ? <p className="error span-2">Не удалось прочитать папку: {files.error.message}. Изменить путь можно в Настройках.</p> : null}
          {files.data && !files.data.length ? <p className="empty span-2">В папке нет GGUF-файлов.</p> : null}
          {createLocal.error ? <p className="error span-2">{createLocal.error.message}</p> : null}
        </form> : <form onSubmit={submitCloud} className="form-grid">
          <label>Название<input name="name" required /></label>
          <label>Провайдер<select value={cloudProvider} onChange={(event) => { setCloudProvider(event.target.value as typeof cloudProvider); setCloudModelRef(""); }}><option value="anthropic">Claude Code</option><option value="openai">Codex CLI</option><option value="opencode">OpenCode</option></select></label>
          <label className="span-2">Модель<input list="cloud-models" value={cloudModelRef} onChange={(event) => setCloudModelRef(event.target.value)} placeholder={cloudProvider === "opencode" ? "opencode/nemotron-3-ultra-free" : undefined} required /><datalist id="cloud-models">{cloudOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</datalist><small>{cloudProvider === "opencode" ? <>Введите ID из <code>opencode models</code>, например <code>opencode/nemotron-3-ultra-free</code>.</> : "Можно выбрать найденную модель или ввести полный ID."}</small></label>
          <small className="span-2">Tools, Vision и Reasoning для облачных моделей включаются автоматически.</small>
          <button className="primary" disabled={createCloud.isPending}>{createCloud.isPending ? "Подключаем…" : "Подключить"}</button>{createCloud.error ? <p className="error">{createCloud.error.message}</p> : null}
        </form>}
      </Panel>
      <Panel title={`Подключено: ${models.data?.length ?? 0}`}><div className="stack">{models.data?.map((model) => {
        const runner = chooseRunner(model, ["prompt"], runners.data ?? []);
        const checking = testModel.isPending && testModel.variables?.modelId === model.id;
        const modelProfiles = visibleProfiles.filter((profile) => profile.modelId === model.id);
        return <details className={draggedModelId === model.id ? "model-card dragging" : "model-card"} key={model.id} draggable={handleModelId === model.id} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", model.id); setDraggedModelId(model.id); }} onDragEnd={() => { setDraggedModelId(null); setHandleModelId(null); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }} onDrop={(event) => { event.preventDefault(); const draggedId = draggedModelId ?? event.dataTransfer.getData("text/plain"); if (draggedId && draggedId !== model.id) reorder.mutate(moveModel(models.data ?? [], draggedId, model.id).map((item) => item.id)); setDraggedModelId(null); setHandleModelId(null); }}><summary className="model-card-summary"><span className="model-drag-handle" role="img" aria-label="Перетащите модель, чтобы изменить порядок" title="Перетащите, чтобы изменить порядок" onPointerDown={() => setHandleModelId(model.id)} onPointerUp={() => setHandleModelId(null)} onClick={(event) => event.preventDefault()}>⠿</span><span className="model-card-copy"><span className="mono">{model.kind === "local-gguf" ? "Локальная GGUF" : "Облачная CLI"} · {model.provider}</span><strong>{model.name}</strong><span>{model.kind === "local-gguf" ? model.path?.split("/").at(-1) : model.modelRef}</span>{model.kind === "local-gguf" && model.sizeBytes ? <span className="model-card-facts">{ggufSummary(model.sizeBytes, model.expertCount)}</span> : null}</span><span className="model-card-state">{settings.data?.externalModelId === model.id ? <span className="chip active-chip">Активна для omp-local</span> : null}<span className="expand-label">Настройки</span></span></summary><div className="model-card-content">
          <form className="model-rename" onSubmit={(event) => submitRename(event, model.id)}><label>Название в результатах<input name="name" defaultValue={model.name} required /></label><button className="primary" disabled={rename.isPending && rename.variables?.modelId === model.id}>{rename.isPending && rename.variables?.modelId === model.id ? "Сохраняем…" : "Сохранить название"}</button></form>
          {model.kind === "cloud" ? <form className="model-economics" onSubmit={(event) => submitEconomics(event, model.id)}><label>Подписка в месяц, $<input name="monthlyCost" type="number" min="0" step="0.01" defaultValue={model.economics?.monthlyCost ?? ""} placeholder="не считаем" /></label><label>Прогонов за эти деньги<input name="includedRunEstimate" type="number" min="0" step="1" defaultValue={model.economics?.includedRunEstimate ?? ""} placeholder="не считаем" /></label><button disabled={saveEconomics.isPending && saveEconomics.variables?.modelId === model.id}>{saveEconomics.isPending && saveEconomics.variables?.modelId === model.id ? "Сохраняем…" : "Сохранить оценку"}</button><small>Ваша оценка в долларах, а не цена провайдера: она делится на число прогонов и показывается в лидерборде как ориентир. Пустые поля — цену не показываем.</small></form> : null}
          {rename.error && rename.variables?.modelId === model.id ? <p className="error">{rename.error.message}</p> : null}
          {model.kind === "local-gguf" ? <ModelCapabilitiesForm key={`${model.id}:${model.mmprojPath}:${JSON.stringify(model.capabilities)}`} model={model} files={files.data ?? []} pending={saveCapabilities.isPending && saveCapabilities.variables?.modelId === model.id} save={saveCapabilities.mutate} /> : null}
          {saveCapabilities.error && saveCapabilities.variables?.modelId === model.id ? <p className="error">{saveCapabilities.error.message}</p> : null}
          {model.kind === "local-gguf" && modelProfiles[0] ? <details className="profile-group" open><summary><span>Профили запуска</span><span>{modelProfiles.length}</span></summary><div className="profile-group-content">
          <NewProfileForm modelId={model.id} source={modelProfiles[0]} pending={createProfile.isPending} create={createProfile.mutateAsync} />
          {createProfile.error ? <p className="error">{createProfile.error.message}</p> : null}
          {modelProfiles.map((profile) => { const report = hardware[profile.id]; const isActive = settings.data?.externalModelId === model.id && settings.data.externalProfileName === profile.name; return <section className="profile-card" key={profile.id}>
            <div className="profile-heading"><div><strong>{profile.name}</strong><span>версия {profile.revision}{profile.calibrated ? " · проверена" : ""}</span></div>{isActive ? <span className="status status-completed">Для omp-local</span> : null}</div>
            <dl className="profile-summary"><div><dt>Контекст</dt><dd>{String(profile.parameters.context)}</dd></div><div><dt>GPU-слои</dt><dd>{String(profile.parameters.nGpuLayers)}</dd></div><div><dt>KV cache</dt><dd>{profile.parameters.cacheTypeK} / {profile.parameters.cacheTypeV}</dd></div><div><dt>Batch</dt><dd>{profile.parameters.batchSize} / {profile.parameters.ubatchSize}</dd></div><div><dt>Fit</dt><dd>{profile.parameters.fit ? `${profile.parameters.fitTargetMiB} MiB · min ${profile.parameters.fitContextMin}` : "выключен"}</dd></div><div><dt>Температура</dt><dd>{profile.parameters.temperature ?? DEFAULT_LLAMA_TEMPERATURE}</dd></div><div><dt>Seed</dt><dd>{profile.parameters.seed ?? "случайный"}</dd></div></dl>
            {report ? <div className="gpu-report"><strong>{report.gpu.name}</strong><span>VRAM: {report.gpu.usedMiB} MiB занято · {report.gpu.freeMiB} MiB свободно из {report.gpu.totalMiB} MiB</span></div> : null}
            {calibrate.error && calibrate.variables === profile.id ? <p className="error">{calibrate.error.message}</p> : null}
            {activate.error && activate.variables?.modelId === model.id && activate.variables.profileName === profile.name ? <p className="error">{activate.error.message}</p> : null}
            <div className="model-toolbar"><button onClick={() => calibrate.mutate(profile.id)} disabled={calibrate.isPending && calibrate.variables === profile.id}>{calibrate.isPending && calibrate.variables === profile.id ? "Запускаем и проверяем…" : profile.parameters.fit ? "Проверить автоконфигурацию" : "Проверить профиль"}</button><button className="primary" onClick={() => activate.mutate({ modelId: model.id, profileName: profile.name })} disabled={activate.isPending && activate.variables?.modelId === model.id && activate.variables.profileName === profile.name}>{activate.isPending && activate.variables?.modelId === model.id && activate.variables.profileName === profile.name ? "Настраиваем omp-local…" : "Использовать с omp-local"}</button><button className="danger" aria-label={`Удалить профиль «${profile.name}»`} disabled={modelProfiles.length <= 1 || (deleteProfile.isPending && deleteProfile.variables?.id === profile.id)} onClick={() => confirm({ title: "Удалить профиль?", body: `Профиль «${profile.name}» и его ревизии будут удалены. Результаты прошлых запусков останутся.`, action: "Удалить", onConfirm: () => deleteProfile.mutate(profile) })}>{deleteProfile.isPending && deleteProfile.variables?.id === profile.id ? "Удаляем…" : "Удалить"}</button></div>
            {deleteProfile.error && deleteProfile.variables?.id === profile.id ? <p className="error">{deleteProfile.error.message}</p> : null}
          </section>; })}</div></details> : null}
          <div className="model-toolbar"><button onClick={() => runner && testModel.mutate({ modelId: model.id, runnerId: runner.id })} disabled={!runner || checking}>{checking ? "Проверяем ответ…" : "Проверить модель"}</button>{checking ? <span className="check-badge"><span className="spinner" />Ждём ответ модели…</span> : diagnostics[model.id] ? <span className={diagnostics[model.id]?.ok ? "check-badge check-pass" : "check-badge check-fail"}>{diagnostics[model.id]?.ok ? "✓" : "✕"} {diagnostics[model.id]?.title}</span> : <small>{runner ? `через ${runner.name}` : "Нет подходящего runner"}</small>}<button className="danger model-disconnect" disabled={disconnect.isPending && disconnect.variables === model.id} onClick={() => { confirm({ title: "Отключить модель?", body: `«${model.name}» пропадёт из списка. Результаты прошлых запусков останутся, файл модели не удаляется.`, action: "Отключить", onConfirm: () => disconnect.mutate(model.id) }); }}>{disconnect.isPending && disconnect.variables === model.id ? "Отключаем…" : "Отключить модель"}</button></div>
          {diagnostics[model.id]?.detail ? <p className="model-check-detail">{diagnostics[model.id]?.detail}</p> : null}
          {disconnect.error && disconnect.variables === model.id ? <p className="error">{disconnect.error.message}</p> : null}
        </div></details>;
      })}{!models.data?.length ? <Empty>Пока нет подключённых моделей.</Empty> : null}</div></Panel>
    </div>
  {confirmView}
  </Page>;
}
