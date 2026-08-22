import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Page, Panel, useData } from "../shell.js";
import type { AppSettings, LocalModelFile, Runner } from "../types.js";

export function SettingsPage() {
  const client = useQueryClient();
  const settings = useData<AppSettings>("settings", "/settings");
  const files = useData<LocalModelFile[]>("local-model-files", "/local-model-files");
  const diagnostics = useData<Record<string, string>>("diagnostics", "/diagnostics");
  const runners = useData<Runner[]>("runners", "/runners");
  const [modelDirectory, setModelDirectory] = useState("");
  const [directoryTouched, setDirectoryTouched] = useState(false);
  useEffect(() => {
    if (settings.data && !directoryTouched) setModelDirectory(settings.data.modelDirectory);
  }, [directoryTouched, settings.data]);
  const saveDirectory = useMutation({
    mutationFn: () => api("/settings/model-directory", { method: "PUT", body: JSON.stringify({ modelDirectory }) }),
    onSuccess: async () => {
      setDirectoryTouched(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["settings"] }),
        client.invalidateQueries({ queryKey: ["local-model-files"] }),
      ]);
    },
  });
  return <Page title="Настройки приложения" eyebrow="Настройки" intro="Здесь меняются только доверенные серверные пути. Команды запуска и пути отдельных моделей браузер не задаёт.">
    <Panel title="Каталог локальных моделей"><form className="directory-form" onSubmit={(event) => { event.preventDefault(); saveDirectory.mutate(); }}><label>Папка с GGUF-файлами<input value={modelDirectory} onChange={(event) => { setModelDirectory(event.currentTarget.value); setDirectoryTouched(true); }} placeholder="models" required /><small>Укажите абсолютный путь к папке. Приложение покажет обычные GGUF-файлы только из её верхнего уровня.</small></label><button className="primary" disabled={saveDirectory.isPending || !directoryTouched}>{saveDirectory.isPending ? "Проверяем…" : "Сохранить путь"}</button></form>
      {saveDirectory.isSuccess ? <p className="success">Путь сохранён, список моделей обновлён.</p> : null}
      {saveDirectory.error ? <p className="error">{saveDirectory.error.message}</p> : null}
      {files.error ? <p className="error">Папка недоступна: {files.error.message}</p> : null}
      {files.data ? <div className="directory-state"><strong>{files.data.length} GGUF</strong><span>{files.data.filter((file) => file.connectedModelId).length} уже подключено</span></div> : null}
    </Panel>
    <div className="two-col settings-grid"><Panel title="Система"><dl>{Object.entries(diagnostics.data ?? {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>{settings.data?.externalModelId ? <div className="active-export"><span className="mono">Экспортированный профиль</span><strong>{settings.data.externalProfileName} · порт {settings.data.externalPort}</strong><small>.data/exports/active-model.fish</small></div> : <p className="empty">Профиль для внешнего запуска пока не экспортирован.</p>}</Panel><Panel title="Способы запуска"><div className="stack">{runners.data?.map((runner) => <article className="item" key={runner.id}><div><span className="mono">{runner.kind}</span><h3>{runner.name}</h3><code>{runner.exec.join(" ")}</code></div></article>)}</div></Panel></div>
  </Page>;
}
