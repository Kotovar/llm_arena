/**
 * Минимальная обвязка для компонентных тестов: экран результата живёт внутри
 * react-query, тостов и роутера, поэтому без них он не отрисуется.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { ToastProvider } from "./toast.js";

export function installDialogSupport(): void {
  const dialog = globalThis.HTMLDialogElement?.prototype as Partial<HTMLDialogElement> | undefined;
  if (!dialog || typeof dialog.showModal === "function") return;
  dialog.showModal = function showModal(this: HTMLDialogElement) { this.open = true; };
  dialog.close = function close(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event("close")); };
}

export async function renderInApp(ui: ReactNode, path = "/"): Promise<RenderResult & { client: QueryClient }> {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => ui,
    validateSearch: (search: Record<string, unknown>) => ({
      task: typeof search.task === "string" ? search.task : undefined,
      mode: search.mode === "text" || search.mode === "web" ? search.mode : undefined,
    }),
  });
  // Заглушки маршрутов, на которые ссылаются экраны: без них <Link> падает.
  // Экран, который живёт не на «/» (например /compare), монтируется прямо в свой маршрут:
  // иначе useSearch({ from }) не найдёт совпавшего маршрута.
  const stub = (routePath: string) => createRoute({ getParentRoute: () => rootRoute, path: routePath, component: () => (path.split("?")[0] === routePath ? ui : null), validateSearch: (search: Record<string, unknown>) => search });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, stub("/runs"), stub("/compare"), stub("/tasks"), stub("/models")]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await router.load();
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider><RouterProvider router={router as never} /></ToastProvider>
      </QueryClientProvider>,
    ),
  };
}
