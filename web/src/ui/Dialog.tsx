import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toFailure } from "../lib/useAsync";
import { X } from "lucide-react";
import { Button, IconButton, type ButtonTone } from "./controls";

interface DialogProps {
  title: string;
  onClose(): void;
  /** Blocks Escape and Close while a write is in flight. */
  busy?: boolean;
  /** Extra classes on the dialog element, for a surface wider than a form. */
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}

const TEXT_FIELD = 'textarea, [contenteditable=""], [contenteditable="true"], input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"], [type="hidden"])';
const holdsTextField = (dialog: HTMLElement) => dialog.querySelector(TEXT_FIELD) !== null;

/**
 * A native modal: the top layer owns focus containment and Escape. With no footer
 * there is nothing to dismiss it, so the header carries Close and a tap on the
 * backdrop closes it, unless it holds a text field. A dialog with footer actions has neither.
 */
export function Dialog({ title, onClose, busy, className, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-dialog-focus]")?.focus();
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
      className={["dialog", className ?? ""].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        // Only the backdrop reports the dialog itself as the target.
        // A footerless dialog holding a text field keeps what was typed: only Escape or Close ends it.
        if (!footer && !busy && event.target === event.currentTarget && !holdsTextField(event.currentTarget)) onClose();
      }}
    >
      <header className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        {!footer ? (
          <IconButton label="Close" onClick={onClose} disabled={busy}>
            <X size={16} aria-hidden />
          </IconButton>
        ) : null}
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
  confirmDisabled?: boolean;
  /** `onConfirm` decides when to close, as a multi-step confirm does. */
  keepOpen?: boolean;
  /** Cancel takes focus, for a confirm that should not be one keystroke from done. */
  cancelFocus?: boolean;
  onConfirm(): Promise<void>;
  onClose(): void;
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  tone = "primary",
  confirmDisabled,
  keepOpen,
  cancelFocus,
  onConfirm,
  onClose,
}: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      if (!keepOpen) onClose();
      else setBusy(false);
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
          <Button onClick={onClose} disabled={busy} data-dialog-focus={cancelFocus || undefined}>
            Cancel
          </Button>
          <Button tone={tone} busy={busy} disabled={confirmDisabled} onClick={() => void confirm()}>
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
