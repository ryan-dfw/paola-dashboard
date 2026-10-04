export interface ToastMsg {
  id: number;
  text: string;
  kind?: 'ok' | 'error';
  action?: { label: string; run(): void };
}

export function Toast({ toast, onClose }: { toast: ToastMsg | null; onClose(): void }) {
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.kind || 'ok'}`} role="status" aria-live="polite">
      <span>{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            toast.action!.run();
            onClose();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className="toast-close" onClick={onClose} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
