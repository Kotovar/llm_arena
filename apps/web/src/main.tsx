import { StrictMode, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from "@tanstack/react-query";
import { RouterProvider, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { api } from "./api.js";
import { useConfirm } from "./confirm.js";
import { Launcher } from "./screens/launcher.js";
import { AnalyticsPage } from "./screens/analytics.js";
import { ComparePage } from "./screens/compare.js";
import { GalleryPage } from "./screens/gallery.js";
import { LeaderboardPage } from "./screens/leaderboard.js";
import { ModelsPage } from "./screens/models.js";
import { RunDetail, RunsPage } from "./screens/results.js";
import { SettingsPage } from "./screens/settings.js";
import { Empty, Page, Panel, Shell, useData } from "./shell.js";
import { ToastProvider, useToast } from "./toast.js";
import type { Task, TaskImage } from "./types.js";
import { matchesPromptQuery, taskUpdateBody } from "./ui.js";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 2_000, retry: 1 } } });

function dataBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать изображение"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

async function uploadTaskImages(files: File[]): Promise<TaskImage[]> {
  const images: TaskImage[] = [];
  for (const file of files) {
    images.push(await api<TaskImage>("/task-images", {
      method: "POST",
      body: JSON.stringify({ filename: file.name, mimeType: file.type, dataBase64: await dataBase64(file) }),
    }));
  }
  return images;
}

function TasksPage() {
  const client = useQueryClient();
  const tasks = useData<Task[]>("tasks", "/tasks");
  const [editing, setEditing] = useState<{ taskId: string; name: string; description: string; prompt: string; images: TaskImage[]; files: File[] } | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState("");
  const { confirm, view: confirmView } = useConfirm();
  const toast = useToast();
  const importTasks = useMutation({
    mutationFn: async (file: File) => api<{ created: number; updated: number }>("/tasks/import", { method: "POST", body: await file.text() }),
    onSuccess: async ({ created, updated }) => {
      toast(`Импорт: добавлено ${created}, обновлено ${updated}`);
      await client.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (error) => toast(error.message, "error"),
  });
  const create = useMutation({ mutationFn: (body: unknown) => api("/tasks", { method: "POST", body: JSON.stringify(body) }), onSuccess: () => client.invalidateQueries({ queryKey: ["tasks"] }) });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: unknown }) => api(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }), onSuccess: () => { setEditing(null); return client.invalidateQueries({ queryKey: ["tasks"] }); } });
  const remove = useMutation({ mutationFn: (id: string) => api(`/tasks/${id}`, { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: ["tasks"] }) });
  // Теги правятся отдельным запросом: они живут на задаче, и их правка не создаёт версию промпта.
  const saveTags = useMutation({
    mutationFn: ({ id, tags }: { id: string; tags: string[] }) => api(`/tasks/${id}/tags`, { method: "PUT", body: JSON.stringify({ tags }) }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ["tasks"] }); await client.invalidateQueries({ queryKey: ["gallery"] }); },
  });
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      setUploading(true);
      const description = String(data.get("description") ?? "").trim();
      await create.mutateAsync({ name: data.get("name"), kind: "prompt", prompt: data.get("prompt"), images: await uploadTaskImages(files), ...(description ? { description } : {}) });
      form.reset();
      setFiles([]);
    } finally {
      setUploading(false);
    }
  }
  const found = (tasks.data ?? []).filter((task) => matchesPromptQuery(task, query));
  return <Page title="Подготовленные промпты" eyebrow="Промпты" intro="Добавьте задания, на которых хотите сравнивать модели. История старых запусков не изменится после редактирования.">
    <div className="two-col"><Panel title="Добавить промпт"><form onSubmit={submit} className="form-grid">
      <label className="span-2">Название<input name="name" required /></label>
      <label className="span-2">Краткое описание<input name="description" maxLength={4000} placeholder="Для чего промпт и что проверять" /><small>Только для вас: в модель не уходит, видно в галерее и результатах.</small></label>
      <label className="span-2">Текст промпта<textarea name="prompt" rows={8} required /></label>
      <label className="span-2">Референс-изображения<input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { setFiles(Array.from(event.currentTarget.files ?? []).slice(0, 8)); }} /><small>До 8 PNG, JPEG или WebP; они станут частью неизменяемой версии промпта.</small></label>
      {files.length ? <ul className="image-attachments span-2">{files.map((file, index) => <li key={`${file.name}-${file.lastModified}`}><span>{file.name}</span><button type="button" onClick={() => setFiles((current) => current.filter((_, position) => position !== index))}>Убрать</button></li>)}</ul> : null}
      <button className="primary" disabled={create.isPending || uploading}>{uploading || create.isPending ? "Загружаем…" : "Добавить"}</button>{create.error ? <p className="error">{create.error.message}</p> : null}
    </form></Panel>
    <Panel title={`Промптов: ${found.length} из ${tasks.data?.length ?? 0}`} action={<div className="prompt-transfer">
      <a href="/api/tasks/export" download>Экспорт JSON</a>
      <label className="prompt-import">{importTasks.isPending ? "Импортируем…" : "Импорт JSON"}<input type="file" accept="application/json,.json" disabled={importTasks.isPending} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) importTasks.mutate(file); }} /></label>
    </div>}><label className="prompt-search"><input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Поиск по названию и тексту" aria-label="Поиск промптов" /></label><div className="stack">{found.map((task) => <article className="item prompt-item" key={task.id}>
      <div className="prompt-item-head"><div><span className="mono">Версия {task.currentRevision.revision}</span>{editing?.taskId === task.id ? null : <h3>{task.currentRevision.name}</h3>}{editing?.taskId === task.id || !task.description ? null : <small className="task-description">{task.description}</small>}{task.currentRevision.images.length ? <small className="task-image-summary">Изображения: {task.currentRevision.images.map((image) => image.filename).join(", ")}</small> : null}</div><div className="item-actions">{editing?.taskId === task.id ? null : <button type="button" onClick={() => setEditing({ taskId: task.id, name: task.currentRevision.name, description: task.description ?? "", prompt: task.currentRevision.prompt, images: task.currentRevision.images, files: [] })}>Редактировать</button>}<button type="button" className="danger" disabled={remove.isPending} onClick={() => confirm({ title: "Убрать промпт в архив?", body: `«${task.currentRevision.name}» исчезнет из списка и из выбора при запуске. Результаты прошлых прогонов останутся, но вернуть промпт из интерфейса нельзя.`, action: "В архив", onConfirm: () => remove.mutate(task.id) })}>В архив</button></div></div>
      <form className="prompt-tags-form" onSubmit={(event) => { event.preventDefault(); const value = String(new FormData(event.currentTarget).get("tags") ?? ""); saveTags.mutate({ id: task.id, tags: value.split(",").map((tag) => tag.trim()).filter(Boolean) }); }}>
        <label>Теги<input name="tags" defaultValue={task.tags.join(", ")} placeholder="код, текст" /></label>
        <button disabled={saveTags.isPending && saveTags.variables?.id === task.id}>{saveTags.isPending && saveTags.variables?.id === task.id ? "Сохраняем…" : "Сохранить теги"}</button>
        <small>Через запятую. По ним фильтруется галерея; версию промпта теги не меняют.</small>
      </form>
      {editing?.taskId === task.id ? null : <details className="prompt-preview"><summary>Текст промпта</summary><p>{task.currentRevision.prompt}</p></details>}
      {editing && editing.taskId === task.id ? <form className="prompt-editor" onSubmit={async (event) => { event.preventDefault(); const prompt = editing.prompt.trim(); const name = editing.name.trim(); if (!prompt || !name) return; try { setUploading(true); await update.mutateAsync({ id: task.id, body: taskUpdateBody(task.currentRevision, prompt, [...editing.images, ...await uploadTaskImages(editing.files)], name, editing.description.trim()) }); } finally { setUploading(false); } }}>
        <label>Название<input autoFocus value={editing.name} onChange={(event) => { const name = event.currentTarget.value; setEditing((current) => current ? { ...current, name } : current); }} required /></label>
        <label>Краткое описание<input maxLength={4000} value={editing.description} onChange={(event) => { const description = event.currentTarget.value; setEditing((current) => current ? { ...current, description } : current); }} placeholder="Для чего промпт и что проверять" /></label>
        <label>Текст промпта<textarea rows={10} value={editing.prompt} onChange={(event) => { const prompt = event.currentTarget.value; setEditing((current) => current ? { ...current, prompt } : current); }} required /></label>
        <label>Добавить изображения<input type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={(event) => { const picked = Array.from(event.currentTarget.files ?? []); setEditing((current) => current ? { ...current, files: picked.slice(0, 8 - current.images.length) } : current); }} /><small>До 8 изображений в версии промпта.</small></label>
        {editing.images.length || editing.files.length ? <ul className="image-attachments">{editing.images.map((image) => <li key={image.id}><span>{image.filename}</span><button type="button" onClick={() => setEditing((current) => current ? { ...current, images: current.images.filter((item) => item.id !== image.id) } : current)}>Убрать</button></li>)}{editing.files.map((file, index) => <li key={`${file.name}-${file.lastModified}`}><span>{file.name}</span><button type="button" onClick={() => setEditing((current) => current ? { ...current, files: current.files.filter((_, position) => position !== index) } : current)}>Убрать</button></li>)}</ul> : null}
        <div className="prompt-editor-footer"><small>Запуски с предыдущей версией останутся без изменений.</small><div className="prompt-editor-actions"><button type="button" onClick={() => setEditing(null)} disabled={update.isPending || uploading}>Отмена</button><button className="primary" disabled={update.isPending || uploading || !editing.prompt.trim() || !editing.name.trim()}>{uploading || update.isPending ? "Загружаем…" : "Сохранить версию"}</button></div></div>
        {update.error ? <p className="error">{update.error.message}</p> : null}
      </form> : null}
    </article>)}{!tasks.data?.length ? <Empty>Промптов пока нет. Добавьте первый слева.</Empty> : null}{tasks.data?.length && !found.length ? <Empty>Ничего не нашлось по запросу.</Empty> : null}{remove.error ? <p className="error">{remove.error.message}</p> : null}</div></Panel></div>{confirmView}
  </Page>;
}

const rootRoute = createRootRoute({ component: Shell });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Launcher,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.task === "string" ? { task: search.task } : {}),
    ...(search.mode === "text" || search.mode === "web" ? { mode: search.mode } : {}),
  } as { task?: string; mode?: "text" | "web" }),
});
const tasksRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tasks", component: TasksPage });
const modelsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/models", component: ModelsPage });
const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  component: RunsPage,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.model === "string" ? { model: search.model } : {}),
    ...(typeof search.status === "string" ? { status: search.status } : {}),
  } as { model?: string; status?: string }),
});
function RunDetailRoute() { const { runId } = runRoute.useParams(); return <RunDetail runId={runId} />; }
const runRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs/$runId", component: RunDetailRoute });
const leaderboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/leaderboard", component: LeaderboardPage });
const compareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/compare",
  component: ComparePage,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.left === "string" ? { left: search.left } : {}),
    ...(typeof search.right === "string" ? { right: search.right } : {}),
  } as { left?: string; right?: string }),
});
const analyticsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/analytics", component: AnalyticsPage });
const galleryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/gallery", component: GalleryPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const routeTree = rootRoute.addChildren([indexRoute, tasksRoute, modelsRoute, runsRoute, runRoute, leaderboardRoute, compareRoute, analyticsRoute, galleryRoute, settingsRoute]);
const router = createRouter({ routeTree, defaultPreload: "intent" });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }

createRoot(document.getElementById("root")!).render(<StrictMode><ToastProvider><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></ToastProvider></StrictMode>);
