import { Lock, PenLine, ShieldOff, Sparkles, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelInfo, PermissionMode } from "../../api/types";
import { FloatingPanel } from "./ModelPicker";
import { effortOption, effortValue } from "./modelStore";
import { EffortGlyph } from "./EffortGlyph";
import { useUi } from "../../state/ui";

export const ACCESS: Record<PermissionMode, { label: string; description: string; icon: LucideIcon }> = {
  supervised: { label: "Supervised", description: "Ask before commands and file changes.", icon: Lock },
  auto_edits: {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLine,
  },
  auto: {
    label: "Auto",
    description: "Supported engines approve routine actions; others still ask.",
    icon: Sparkles,
  },
  full_access: { label: "Full access", description: "Allow commands and edits without prompts.", icon: ShieldOff },
};

const MODES = Object.keys(ACCESS) as PermissionMode[];

/** Per-model options the service can take on a turn. The values always come from the model. */
const TRAIT_OPTIONS = ["effort"];

function TraitsMenu({
  model,
  effort,
  access,
  anchor,
  toAccess,
  onEffort,
  onAccess,
  onClose,
}: {
  model: ModelInfo | null;
  effort: string | null;
  access: PermissionMode | null;
  anchor: DOMRect;
  toAccess: boolean;
  onEffort(value: string): void;
  onAccess(mode: PermissionMode): void;
  onClose(): void;
}) {
  const options = (model?.options ?? []).filter((entry) => TRAIT_OPTIONS.includes(entry.id));
  const current = effortValue(model, effort);
  const section = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (toAccess) section.current?.scrollIntoView({ block: "end" });
    body.current?.querySelector<HTMLElement>("[role^=menuitemradio][aria-checked=true]")?.focus();
  }, [toAccess]);
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    const items = [...(body.current?.querySelectorAll<HTMLElement>("[role^=menuitemradio]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const down = event.key === "ArrowDown" || event.key === "ArrowRight";
    if (down || event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      items[(at + (down ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  return (
    <FloatingPanel anchor={anchor} label="Composer options" className="traits-menu" onClose={onClose}>
      <div ref={body} className="traits-body" role="menu" aria-label="Composer options" onKeyDown={onKey}>
        {options.map((option, index) => (
          <div key={option.id} role="group" aria-label={option.label}>
            {index > 0 ? <hr /> : null}
            <div className="traits-label">{option.label}</div>
            {option.values.map((value) => (
              <button
                key={value.id}
                type="button"
                role="menuitemradio"
                aria-checked={value.id === current?.id}
                className="traits-item"
                onClick={() => {
                  onEffort(value.id);
                  onClose();
                }}
              >
                <span>{value.label}</span>
                {value.default ? <em>Default</em> : null}
              </button>
            ))}
          </div>
        ))}
        {options.length > 0 && access ? <hr /> : null}
        {access ? (
          <div ref={section} data-composer-permissions>
            <div className="traits-label">Permissions</div>
            <div className="access-segment" role="group" aria-label="Permissions">
              {MODES.map((mode) => {
                const Icon = ACCESS[mode].icon;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="menuitemradio"
                    aria-checked={mode === access}
                    aria-label={ACCESS[mode].label}
                    title={ACCESS[mode].label}
                    onClick={() => onAccess(mode)}
                  >
                    <Icon size={14} aria-hidden />
                  </button>
                );
              })}
            </div>
            <p className="access-note">{ACCESS[access].description}</p>
          </div>
        ) : null}
      </div>
    </FloatingPanel>
  );
}

interface Open {
  anchor: DOMRect;
  toAccess: boolean;
}

/** The effort control beside the model and the access control under the composer share a menu. */
export function useTraitsMenu(input: {
  model: ModelInfo | null;
  effort: string | null;
  access: PermissionMode | null;
  onEffort(value: string): void;
  onAccess(mode: PermissionMode): void;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const openAt = (element: HTMLElement, toAccess: boolean) =>
    setOpen(open ? null : { anchor: element.getBoundingClientRect(), toAccess });
  const menu = open ? (
    <TraitsMenu {...input} anchor={open.anchor} toAccess={open.toAccess} onClose={close} />
  ) : null;
  return { openAt, menu };
}

export function EffortTrigger({
  model,
  effort,
  access,
  disabled,
  onOpen,
}: {
  model: ModelInfo | null;
  effort: string | null;
  access: PermissionMode | null;
  disabled?: boolean;
  onOpen(element: HTMLElement): void;
}) {
  const display = useUi((state) => state.effortDisplay);
  const option = effortOption(model);
  const current = effortValue(model, effort);
  if (!option) return null;
  const parts = [`Effort: ${current?.label ?? "Default"}`, access ? `Permissions: ${ACCESS[access].label}` : null];
  const levels = option.values;
  const at = levels.findIndex((value) => value.id === current?.id);
  const named = current === null || current.id === "max";
  return (
    <button
      type="button"
      className="composer-control composer-effort"
      aria-label={parts.filter(Boolean).join(" · ")}
      aria-haspopup="menu"
      disabled={disabled}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {display === "bars" && !named ? (
        <EffortGlyph count={levels.filter((value) => value.id !== "max").length} filled={at + 1} />
      ) : (
        (current?.label ?? option.label)
      )}
    </button>
  );
}
