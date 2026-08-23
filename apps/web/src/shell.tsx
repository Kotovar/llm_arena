import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { api } from "./api.js";
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

export function Shell() {
  const groups = [
    { label: "Запуск", links: [["/", "Новый запуск"]] },
    { label: "Анализ", links: [["/runs", "Результаты"], ["/compare", "Сравнение"], ["/gallery", "Галерея"]] },
    { label: "Подготовка", links: [["/tasks", "Промпты"], ["/models", "Модели"], ["/settings", "Настройки"]] },
  ] as const;
  return <div className="shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">A/B</span><div><strong>LLM Arena</strong><small>сравнение моделей</small></div></div><nav aria-label="Навигация LLM Arena">{groups.map((group) => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.links.map(([to, label]) => <Link key={to} to={to} activeOptions={{ exact: to === "/" }}>{label}</Link>)}</div>)}</nav><div className="host"><span className="host-label">Локальный узел</span><span><i className="pulse" />127.0.0.1</span></div></aside><main className="content"><Outlet /></main></div>;
}
