import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type ToastTone = "success" | "error";
type ToastItem = { id: number; message: string; tone: ToastTone };
type PushToast = (message: string, tone?: ToastTone) => void;

const ToastContext = createContext<PushToast | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const push = useCallback<PushToast>((message, tone = "success") => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 2_500);
  }, []);
  return <ToastContext.Provider value={push}>{children}<div className="toast-stack" role="status" aria-live="polite">{toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.tone}`}>{toast.message}</div>)}</div></ToastContext.Provider>;
}

export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error("useToast must be used within ToastProvider");
  return push;
}
