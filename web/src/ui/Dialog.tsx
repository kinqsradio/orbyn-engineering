import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { toFailure } from "../lib/useAsync";
import { Button, IconButton, type ButtonTone } from "./controls";

interface DialogProps {
  title: string;
  onClose(): void;
  /** Blocks Escape and Close while a write is in flight. */
  busy?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}

/** A native modal: the top layer owns focus containment and Escape. */
export function Dialog({ title, onClose, busy, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      const target =
        opener?.isConnected && opener.offsetParent !== null
          ? opener
          : document.querySelector<HTMLElement>("[data-page-title]");
      target?.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <IconButton label="Close" onClick={onClose} disabled={busy}>
          <X size={16} aria-hidden />
        </IconButton>
      </header>
      <div className="dialog-body">{children}</div>
      {footer ? <footer className="dialog-foot">{footer}</footer> : null}
    </dialog>
  );
}

interface ConfirmProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  tone?: ButtonTone;
  onConfirm(): Promise<void>;
  onClose(): void;
}

export function ConfirmDialog({ title, children, confirmLabel, tone = "primary", onConfirm, onClose }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (failure) {
      setError(toFailure(failure).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button tone={tone} busy={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
