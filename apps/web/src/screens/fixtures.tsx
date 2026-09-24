import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, apiText } from "../api.js";
import { Empty, Page, Panel, Skeleton, useData } from "../shell.js";
import { useToast } from "../toast.js";
import type { Fixture } from "../types.js";
import { ResultPreview, stopPreviewTarget, useStopPreviewOnUnmount } from "./results.js";

type Verification = {
  fixtureId: string;
  revision: string;
  checks: Array<{ id: string; label: string; status: string; hidden: boolean }>;
  baseline: Array<{ id: string; expected: "pass" | "fail"; actual: string; ok: boolean }>;
  problems: string[];
  ok: boolean;
};

const statusLabels: Record<string, string> = { pass: "прошла", fail: "упала", timeout: "не уложилась в лимит", missing: "не запускалась" };

/** Упавшая проверка с ожидаемым `fail` — это норма: значит баг в исходном состоянии на месте. */
function VerificationReport({ report }: { report: Verification }) {
  const expected = new Map(report.baseline.map((entry) => [entry.id, entry]));
  return <div className="stack">
    <p className={report.ok ? "" : "error"}>{report.ok ? "Fixture в объявленном состоянии." : "Fixture не готов."}</p>
    <table className="analytics-table"><thead><tr><th>Проверка</th><th>Результат</th><th>Объявлено</th></tr></thead><tbody>
      {report.checks.map((check) => {
        const match = expected.get(check.id);
        return <tr key={check.id}>
          <td>{check.label}{check.hidden ? <span className="mono"> скрытая</span> : null}</td>
          <td>{statusLabels[check.status] ?? check.status}</td>
          <td>{!match ? "—" : match.ok ? "как задумано" : `ожидалось ${statusLabels[match.expected]}`}</td>
        </tr>;
      })}
    </tbody></table>
    {report.problems.length ? <ul className="error">{report.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
    <small className="mono">ревизия {report.revision.slice(0, 12)}</small>
  </div>;
}

function FixtureFiles({ fixtureId }: { fixtureId: string }) {
  const [selected, setSelected] = useState<string>();
  const files = useQuery({ queryKey: ["fixture-files", fixtureId], queryFn: () => api<string[]>(`/fixtures/${fixtureId}/files`) });
  const content = useQuery({
    queryKey: ["fixture-file", fixtureId, selected],
    queryFn: () => apiText(`/fixtures/${fixtureId}/files?path=${encodeURIComponent(selected!)}`),
    enabled: Boolean(selected),
  });
  if (files.isLoading) return <Skeleton rows={5} />;
  if (files.error) return <p className="error">{files.error.message}</p>;
  return <div className="fixture-files">
    <ul>{files.data?.toSorted().map((file) => <li key={file}>
      <button type="button" className={file === selected ? "active" : ""} onClick={() => setSelected(file)}>{file}</button>
    </li>)}</ul>
    {selected ? <pre className="artifact">{content.isLoading ? "Загружаем…" : content.error ? content.error.message : content.data}</pre> : <Empty>Выберите файл, чтобы увидеть, с чего начнёт модель.</Empty>}
  </div>;
}

/** Строка проекта: название и действия всегда на виду, подсказка ревьюеру и файлы — по «Подробнее». */
function FixtureRow({ fixture }: { fixture: Fixture }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<Verification>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const target = previewUrl ? { fixtureId: fixture.id } : undefined;
  useStopPreviewOnUnmount(target);
  const verify = useMutation({
    mutationFn: () => api<Verification>(`/fixtures/${fixture.id}/verify`, { method: "POST" }),
    onSuccess: (result) => {
      setReport(result);
      toast(result.ok ? "Fixture в объявленном состоянии." : "Fixture не готов, подробности в отчёте.");
    },
  });
  const startPreview = useMutation({
    mutationFn: () => api<{ url: string }>(`/fixtures/${fixture.id}/preview`, { method: "POST" }),
    onSuccess: (started) => setPreviewUrl(started.url),
  });
  const stopPreview = useMutation({
    mutationFn: () => stopPreviewTarget({ fixtureId: fixture.id }),
    onSuccess: () => setPreviewUrl(undefined),
  });
  return <section className="fixture-row">
    <header>
      <div><h3>{fixture.name}</h3><code>{fixture.id}</code></div>
      <div className="panel-actions">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Свернуть" : "Подробнее"}</button>
        {fixture.preview ? <button type="button" onClick={() => startPreview.mutate()} disabled={startPreview.isPending || Boolean(previewUrl)}>{startPreview.isPending ? "Запускаем…" : "Запустить оригинал"}</button> : null}
        <button type="button" className="primary" onClick={() => verify.mutate()} disabled={verify.isPending}>{verify.isPending ? "Проверяем…" : "Проверить состояние"}</button>
      </div>
    </header>
    {startPreview.error ? <p className="error">{startPreview.error.message}</p> : null}
    {verify.error ? <p className="error">{verify.error.message}</p> : null}
    {previewUrl ? <ResultPreview url={previewUrl} target={{ fixtureId: fixture.id }} onClose={() => stopPreview.mutate()} closing={stopPreview.isPending} title={`Исходное состояние: ${fixture.name}`} /> : null}
    {report ? <VerificationReport report={report} /> : null}
    {open ? <div className="stack">
      {fixture.reproduction ? <p className="benchmark-reproduction"><strong>Как проверить:</strong> {fixture.reproduction}</p> : null}
      <FixtureFiles fixtureId={fixture.id} />
    </div> : null}
  </section>;
}

export function FixturesPage() {
  const fixtures = useData<Fixture[]>("fixtures", "/fixtures");
  return <Page
    title="Исходные проекты"
    eyebrow="Подготовка"
    intro="То, что модель получает в начале задачи. Здесь же видно, действительно ли исходное состояние такое, какое нужно заданию: запускать бенчмарк на уже исправленном баге бессмысленно."
  >
    {fixtures.isLoading ? <Skeleton rows={4} /> : null}
    {fixtures.error ? <p className="error">{fixtures.error.message}</p> : null}
    {fixtures.data?.length === 0 ? <Empty>Ни одного исходного проекта не объявлено.</Empty> : null}
    {fixtures.data?.length ? <div className="fixture-list">{fixtures.data.map((fixture) => <FixtureRow key={fixture.id} fixture={fixture} />)}</div> : null}
  </Page>;
}
