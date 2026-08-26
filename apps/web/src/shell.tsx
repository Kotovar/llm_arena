import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api } from "./api.js";
import type { GpuInfo } from "./types.js";
import { statusLabel } from "./ui.js";

export function useData<T>(key: string, path = key) {
  return useQuery({ queryKey: [key], queryFn: () => api<T>(path) });
}

export function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return <section className="panel"><header className="panel-head"><h2>{title}</h2>{action}</header>{children}</section>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
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
  const gpu = useQuery({ queryKey: ["gpu"], queryFn: () => api<GpuInfo | null>("/gpu"), refetchInterval: 20_000, staleTime: 15_000 });
  const info = gpu.data;
  if (!info) return <div className="host"><span className="host-label">Локальный узел</span><span><i className="pulse" />127.0.0.1</span></div>;
  const usedShare = Math.min(100, Math.round((info.usedMiB / Math.max(info.totalMiB, 1)) * 100));
  return <div className="host"><span className="host-label">Видеокарта</span>
    <span className="host-gpu"><i className="pulse" />{info.name}</span>
    <span className="host-vram"><i style={{ width: `${usedShare}%` }} /></span>
    <small>{gib(info.freeMiB)} свободно из {gib(info.totalMiB)}</small>
  </div>;
}

export function Shell() {
  const groups = [
    { label: "Запуск", links: [["/", "Новый запуск"]] },
    { label: "Анализ", links: [["/runs", "Результаты"], ["/leaderboard", "Лидерборд"], ["/compare", "Сравнение"], ["/gallery", "Галерея"]] },
    { label: "Подготовка", links: [["/tasks", "Промпты"], ["/models", "Модели"], ["/settings", "Настройки"]] },
  ] as const;
  return <div className="shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">A/B</span><div><strong>LLM Arena</strong><small>сравнение моделей</small></div></div><nav aria-label="Навигация LLM Arena">{groups.map((group) => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.links.map(([to, label]) => <Link key={to} to={to} activeOptions={{ exact: to === "/" }}>{label}</Link>)}</div>)}</nav><HostCard /></aside><main className="content"><Outlet /></main></div>;
}
