import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api.js";
import { useToast } from "./toast.js";
import type { GpuInfo, Model, Run } from "./types.js";
import { finishedSince, runIsActive, runModelName, statusLabel } from "./ui.js";

export function useData<T>(key: string, path = key) {
  return useQuery({ queryKey: [key], queryFn: () => api<T>(path) });
}

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="panel"><header className="panel-head"><h2>{title}</h2>{action}</header>{children}</section>;
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return <div className="empty"><p>{children}</p>{action}</div>;
}

/** Пока данные едут, показываем их будущую форму: текст «загружаем» тут же сменяется таблицей и всё прыгает. */
export function Skeleton({ rows = 4 }: { rows?: number }) {
  return <div className="skeleton" role="status" aria-label="Загружаем данные">{Array.from({ length: rows }, (_, index) => <span key={index} />)}</div>;
}

export function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{statusLabel(value)}</span>;
}

export function Page({ title, eyebrow, intro, children }: { title: string; eyebrow: string; intro?: string; children: ReactNode }) {
  return <><header className="page-head"><span>{eyebrow}</span><h1>{title}</h1>{intro ? <p>{intro}</p> : null}</header>{children}</>;
}

function gib(mib: number) {
  return `${(mib / 1024).toFixed(1)} GiB`;
}

function HostCard() {
  const toast = useToast();
  const gpu = useQuery({ queryKey: ["gpu"], queryFn: () => api<GpuInfo | null>("/gpu"), refetchInterval: 20_000, staleTime: 15_000 });
  const unload = useMutation({
    mutationFn: () => api<{ stopped: boolean; stoppedOmp: boolean }>("/external-launcher/unload", { method: "POST" }),
    onSuccess: async ({ stopped, stoppedOmp }) => {
      await gpu.refetch();
      toast(stopped ? "Выгрузка модели подтверждена" : stoppedOmp ? "Сеанс omp-local остановлен; проверьте VRAM" : "Запущенной модели Arena не найдено", stopped ? "success" : "error");
    },
    onError: (error) => toast(error.message, "error"),
  });
  const info = gpu.data;
  if (!info) return <div className="host"><span className="host-label">Локальный узел</span><span><i className="pulse" />127.0.0.1</span></div>;
  const usedShare = Math.min(100, Math.round((info.usedMiB / Math.max(info.totalMiB, 1)) * 100));
  return <div className="host"><span className="host-label">Видеокарта</span>
    <span className="host-gpu"><i className="pulse" />{info.name}</span>
    <span className="host-vram"><i style={{ width: `${usedShare}%` }} /></span>
    <small>{gib(info.freeMiB)} свободно из {gib(info.totalMiB)}</small>
    <button type="button" className="host-unload danger" onClick={() => unload.mutate()} disabled={unload.isPending}>{unload.isPending ? "Выгружаем…" : "Выгрузить из VRAM"}</button>
  </div>;
}

function Elapsed({ since }: { since: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!since) return null;
  const seconds = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1_000));
  return <>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</>;
}

/** Прогон идёт минутами: о нём должно быть видно с любого экрана, а о завершении — сказано. */
function ActivityCard() {
  const toast = useToast();
  const previous = useRef<Run[]>([]);
  const runs = useQuery({
    queryKey: ["runs"],
    queryFn: () => api<Run[]>("/runs"),
    refetchInterval: (query) => query.state.data?.some(runIsActive) ? 2_000 : 15_000,
  });
  const models = useQuery({ queryKey: ["models"], queryFn: () => api<Model[]>("/models") });
  useEffect(() => {
    if (!runs.data) return;
    for (const run of finishedSince(previous.current, runs.data)) {
      const name = runModelName(run, models.data ?? []);
      toast(`${name}: ${statusLabel(run.status).toLowerCase()}`, run.status === "completed" ? "success" : "error");
    }
    previous.current = runs.data;
  }, [runs.data, models.data, toast]);
  const active = runs.data?.filter(runIsActive) ?? [];
  if (!active.length) return null;
  const [current, ...queued] = active;
  return <Link className="activity" to="/runs/$runId" params={{ runId: current!.id }}>
    <span className="activity-head"><i className="spinner" /><strong>{runModelName(current!, models.data ?? [])}</strong></span>
    <span className="activity-meta"><span>{statusLabel(current!.activityStatus ?? current!.status)}</span><span><Elapsed since={current!.started_at} /></span></span>
    {queued.length ? <small>ещё {queued.length} в очереди</small> : null}
  </Link>;
}

export function Shell() {
  const groups = [
    { label: "Запуск", links: [["/", "Новый запуск"]] },
    { label: "Анализ", links: [["/runs", "Результаты"], ["/leaderboard", "Лидерборд"], ["/compare", "Сравнение"], ["/analytics", "Аналитика"], ["/gallery", "Галерея"]] },
    { label: "Подготовка", links: [["/tasks", "Промпты"], ["/models", "Модели"], ["/settings", "Настройки"]] },
  ] as const;
  return <div className="shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">A/B</span><div><strong>LLM Arena</strong><small>сравнение моделей</small></div></div><nav aria-label="Навигация LLM Arena">{groups.map((group) => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.links.map(([to, label]) => <Link key={to} to={to} activeOptions={{ exact: to === "/" }}>{label}</Link>)}</div>)}</nav><ActivityCard /><HostCard /></aside><main className="content"><Outlet /></main></div>;
}
