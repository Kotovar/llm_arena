import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { api } from "./api.js";
import { ChevronDownIcon, ChevronUpIcon } from "./icons.js";
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

/**
 * Нативные стрелки числового поля не оформляются ни в одном движке, поэтому они спрятаны
 * в styles.css, а шаг задаётся своими кнопками через stepUp/stepDown — те сами уважают
 * min, max и step. Событие input отправляем вручную: программная смена value его не рождает.
 */
// step только числом: на step="any" нативный stepUp бросает InvalidStateError.
export function NumberField({ step: stepSize, ...props }: Omit<ComponentProps<"input">, "type" | "step"> & { step?: number }) {
  const field = useRef<HTMLInputElement>(null);
  const locked = Boolean(props.disabled || props.readOnly);
  const step = (direction: "up" | "down") => {
    const input = field.current;
    if (!input) return;
    if (direction === "up") input.stepUp(); else input.stepDown();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  // preventDefault на нажатии: иначе клик уводит фокус на кнопку, спрятанную от скринридера.
  const stepButton = (direction: "up" | "down", icon: ReactNode) =>
    <button type="button" tabIndex={-1} disabled={locked} onMouseDown={(event) => event.preventDefault()} onClick={() => step(direction)}>{icon}</button>;
  return <span className="number-field">
    <input {...props} step={stepSize} ref={field} type="number" />
    <span className="number-steps" aria-hidden>{stepButton("up", <ChevronUpIcon />)}{stepButton("down", <ChevronDownIcon />)}</span>
  </span>;
}

/**
 * Сочетание описывается строкой («ctrl+Enter», «/», «ArrowLeft»), а не колбэком-матчером:
 * стабильная строка в зависимостях избавляет от переподписки на каждый рендер.
 */
export type SelectOption = { value: string; label: string; disabled?: boolean };

/**
 * Замена нативному <select>: его выпадающий список рисует ОС, и в ней выбор идёт зажатой кнопкой
 * мыши, а не привычным «кликнул — открылось, кликнул — выбралось». Открытость держит сам <details>.
 * Управляемый режим — value + onSelect, форма с FormData — name + defaultValue через скрытое поле.
 */
export function SelectMenu({ label, options, value, onSelect, name, defaultValue = "", placeholder, disabled }: {
  label: string;
  options: readonly SelectOption[];
  value?: string;
  onSelect?: (value: string) => void;
  name?: string;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [own, setOwn] = useState(defaultValue);
  const field = useRef<HTMLInputElement>(null);
  const current = value ?? own;
  const currentLabel = options.find((option) => option.value === current)?.label ?? placeholder ?? "Выберите";
  // form.reset() откатывает только настоящие поля формы, поэтому своё значение возвращаем сами.
  useEffect(() => {
    const form = field.current?.form;
    if (!form) return;
    const reset = () => setOwn(defaultValue);
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [defaultValue]);
  return <>
    <details className="select-menu" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }} onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.open = false; }}>
      <summary aria-label={label} aria-disabled={disabled} tabIndex={disabled ? -1 : undefined} onClick={(event) => { if (disabled) event.preventDefault(); }}>{currentLabel}</summary>
      <div role="group" aria-label={label}>{options.map((option) => <button
        type="button"
        key={option.value}
        className={option.value === current ? "active" : ""}
        aria-pressed={option.value === current}
        disabled={option.disabled}
        onClick={(event) => {
          setOwn(option.value);
          onSelect?.(option.value);
          const menu = event.currentTarget.closest("details");
          if (menu) menu.open = false;
        }}
      >{option.label}</button>)}</div>
    </details>
    {name ? <input type="hidden" ref={field} name={name} value={current} /> : null}
  </>;
}

export function useHotkey(combo: string, run: (() => void) | undefined) {
  const handler = useRef(run);
  useEffect(() => { handler.current = run; });
  useEffect(() => {
    const parts = combo.split("+");
    const key = parts[parts.length - 1]!;
    const needsModifier = parts.includes("ctrl");
    const onKey = (event: KeyboardEvent) => {
      if (!handler.current || event.key !== key || event.altKey) return;
      // Cmd на macOS и Ctrl в остальных местах — одно и то же сочетание для человека.
      if (needsModifier !== (event.ctrlKey || event.metaKey)) return;
      // Пока открыт модальный диалог, экран под ним не должен реагировать на стрелки.
      if (document.querySelector("dialog[open]")) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target?.closest("input, textarea, select, [contenteditable=\"true\"]"));
      // Из поля ввода работают только сочетания с модификатором: одиночная клавиша там — просто текст.
      if (typing && !needsModifier) return;
      event.preventDefault();
      handler.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [combo]);
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

/**
 * Прогон идёт минутами, и вкладку на это время сворачивают: о завершении сообщаем средствами системы.
 * Спрашивать разрешение полагается из обработчика клика — см. вызов в лаунчере.
 */
export function requestNotifications() {
  if (!("Notification" in window) || Notification.permission !== "default") return Promise.resolve();
  return Notification.requestPermission().then(() => undefined, () => undefined);
}

export function useSystemNotification() {
  return useCallback((title: string, body: string) => {
    // Вкладка на виду — там уже есть тост, второе уведомление было бы дублем.
    if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
    try {
      new Notification(title, { body, tag: "llm-arena-run" });
    } catch {
      // На части платформ конструктор запрещён (нужен service worker) — тоста достаточно.
    }
  }, []);
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
  const notify = useSystemNotification();
  useEffect(() => {
    if (!runs.data) return;
    for (const run of finishedSince(previous.current, runs.data)) {
      const name = runModelName(run, models.data ?? []);
      const message = `${name}: ${statusLabel(run.status).toLowerCase()}`;
      toast(message, run.status === "completed" ? "success" : "error");
      notify("Прогон завершён", message);
    }
    previous.current = runs.data;
  }, [runs.data, models.data, toast, notify]);
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
    { label: "Запуск", links: [["/", "Новый запуск"], ["/batch", "Массовый запуск"]] },
    { label: "Анализ", links: [["/runs", "Результаты"], ["/leaderboard", "Лидерборд"], ["/compare", "Сравнение"], ["/analytics", "Аналитика"], ["/gallery", "Галерея"]] },
    { label: "Подготовка", links: [["/tasks", "Промпты"], ["/models", "Модели"], ["/settings", "Настройки"]] },
  ] as const;
  return <div className="shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">A/B</span><div><strong>LLM Arena</strong><small>сравнение моделей</small></div></div><nav aria-label="Навигация LLM Arena">{groups.map((group) => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.links.map(([to, label]) => <Link key={to} to={to} activeOptions={{ exact: to === "/" }}>{label}</Link>)}</div>)}</nav><ActivityCard /><HostCard /></aside><main className="content"><Outlet /></main></div>;
}
