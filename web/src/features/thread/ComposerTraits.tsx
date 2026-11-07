import { Lock, PenLine, ShieldOff, Sparkles, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineStatus, ModelInfo, ModelOption, PermissionMode } from "../../api/types";
import { FloatingPanel } from "./ModelPicker";
import { effortOption, effortValue } from "../../state/modelStore";
import { EffortGlyph } from "./EffortGlyph";
import { useUi } from "../../state/ui";
import { Presence } from "../../ui/Presence";
import { usePopover } from "../../ui/usePopover";

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

/** The modes an engine offers, in menu order. An older service that does not say offers all. */
export function offeredModes(engine: Pick<EngineStatus, "capabilities"> | null): PermissionMode[] {
  const offered = engine?.capabilities.permission_modes;
  return offered ? MODES.filter((mode) => offered.includes(mode)) : MODES;
}

/** What a saved mode runs as: one the engine does not offer runs, and shows, Supervised. */
export function shownAccess(engine: Pick<EngineStatus, "capabilities"> | null, saved: PermissionMode): PermissionMode {
  return offeredModes(engine).includes(saved) ? saved : "supervised";
}

function TraitsMenu({
  model,
  effort,
  extras,
  access,
  modes,
  anchor,
  toAccess,
  trigger,
  closing,
  onEffort,
  onOption,
  onAccess,
  onClose,
}: {
  model: ModelInfo | null;
  effort: string | null;
  extras: Record<string, string | undefined>;
  access: PermissionMode | null;
  modes: PermissionMode[];
  anchor: DOMRect;
  toAccess: boolean;
  trigger: HTMLElement;
  closing?: boolean;
  onEffort(value: string): void;
  onOption(option: string, value: string): void;
  onAccess(mode: PermissionMode): void;
  onClose(): void;
}) {
  const options = model?.options ?? [];
  const chosen = (option: ModelOption) =>
    option.id === "effort"
      ? effortValue(model, effort)?.id
      : (extras[option.id] ?? option.values.find((value) => value.default)?.id);
  const section = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const popover = usePopover({ kind: "fields", root: panel, trigger: () => trigger, closing, onClose });
  useEffect(() => {
    if (toAccess) section.current?.scrollIntoView({ block: "end" });
    body.current?.querySelector<HTMLElement>("[role^=menuitemradio][aria-checked=true]")?.focus();
  }, [toAccess]);
  const onKey = (event: React.KeyboardEvent) => {
    const items = [...(body.current?.querySelectorAll<HTMLElement>("[role^=menuitemradio]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const down = event.key === "ArrowDown" || event.key === "ArrowRight";
    if (down || event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      items[(at + (down ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  return (
    <FloatingPanel anchor={anchor} label="Composer options" className="traits-menu" closing={closing} panelRef={panel}>
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
                aria-checked={value.id === chosen(option)}
                className="traits-item"
                onClick={() => {
                  popover.dismiss("select");
                  if (option.id === "effort") onEffort(value.id);
                  else onOption(option.id, value.id);
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
              {modes.map((mode) => {
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
  trigger: HTMLElement;
}

/** The effort control beside the model and the access control under the composer share a menu. */
export function useTraitsMenu(input: {
  model: ModelInfo | null;
  effort: string | null;
  /** Choices beyond effort, by the model's option id. */
  extras: Record<string, string | undefined>;
  access: PermissionMode | null;
  /** The modes to offer; every mode when not given. */
  modes?: PermissionMode[];
  onEffort(value: string): void;
  onOption(option: string, value: string): void;
  onAccess(mode: PermissionMode): void;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const openAt = (element: HTMLElement, toAccess: boolean) =>
    setOpen(open ? null : { anchor: element.getBoundingClientRect(), toAccess, trigger: element });
  const menu = (
    <Presence>
      {open ? (
        <TraitsMenu {...input} modes={input.modes ?? MODES} anchor={open.anchor} toAccess={open.toAccess} trigger={open.trigger} onClose={close} />
      ) : null}
    </Presence>
  );
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
      data-effort-trigger
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
