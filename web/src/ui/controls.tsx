import { Check, Copy, Loader2 } from "lucide-react";
import {
  useId,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

export type ButtonTone = "primary" | "secondary" | "quiet" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone;
  small?: boolean;
  busy?: boolean;
  icon?: ReactNode;
}

const buttonClass = (tone: ButtonTone, small?: boolean, extra?: string) =>
  ["btn", `btn-${tone}`, small ? "btn-small" : "", extra ?? ""].filter(Boolean).join(" ");

export function Button({
  tone = "secondary",
  small,
  busy,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={buttonClass(tone, small, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <Loader2 size={16} className="spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

interface LinkButtonProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  tone?: ButtonTone;
  small?: boolean;
  icon?: ReactNode;
}

export function LinkButton({ tone = "secondary", small, icon, children, className, ...rest }: LinkButtonProps) {
  return (
    <a {...rest} className={buttonClass(tone, small, className)}>
      {icon}
      {children}
    </a>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  pressed?: boolean;
}

export function IconButton({ label, pressed, children, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={["icon-btn", className ?? ""].filter(Boolean).join(" ")}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
    >
      {children}
    </button>
  );
}

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}

export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type PillTone = "neutral" | "accent" | "warn" | "danger" | "info";

export function Pill({ tone = "neutral", children, title }: { tone?: PillTone; children: ReactNode; title?: string }) {
  return (
    <span className={`pill pill-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function CopyCommand({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="command">
      <code>{command}</code>
      <IconButton label={copied ? "Copied" : label} onClick={() => void copy()}>
        {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
      </IconButton>
    </div>
  );
}
