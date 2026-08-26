/** Подтверждение опасного действия в оформлении приложения вместо window.confirm. */
import { useEffect, useRef, useState, type ReactNode } from "react";

type Request = { title: string; body: ReactNode; action: string; onConfirm: () => void };

export function useConfirm() {
  const [request, setRequest] = useState<Request>();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (request && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [request]);
  const view = request ? <dialog className="confirm-dialog" ref={dialog} onClose={() => setRequest(undefined)} onCancel={(event) => { event.preventDefault(); dialog.current?.close(); }}>
    <h2>{request.title}</h2>
    <p>{request.body}</p>
    <div className="confirm-actions">
      <button type="button" onClick={() => dialog.current?.close()}>Отмена</button>
      <button type="button" className="danger" onClick={() => { request.onConfirm(); dialog.current?.close(); }}>{request.action}</button>
    </div>
  </dialog> : null;
  return { confirm: setRequest, view };
}
