const defaultError = "Не удалось выполнить запрос. Подробности доступны в техническом логе.";

const translatedErrors: Record<string, string> = {
  "Finish the remaining prompts of this run before restarting with another temperature":
    "Сначала завершите оставшиеся промпты этого запуска, затем повторите с другой температурой.",
};

function userFacingError(message?: string): string {
  if (!message) return defaultError;
  return translatedErrors[message] ?? (/[А-Яа-яЁё]/u.test(message) ? message : defaultError);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`/api${path}`, init);
  } catch {
    throw new Error("Не удалось подключиться к серверу.");
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await request(path, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string; workspace?: string };
    throw Object.assign(new Error(userFacingError(body.error ?? response.statusText)), { data: body });
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function apiText(path: string): Promise<string> {
  const response = await request(path);
  if (!response.ok) throw new Error(userFacingError(response.statusText));
  return response.text();
}
