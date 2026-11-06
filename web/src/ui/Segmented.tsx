import { useRef } from "react";

/** A short list of exclusive choices shown side by side; arrow keys move the choice. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
}) {
  const group = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={group}
      className="segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const at = options.findIndex((option) => option.value === value);
        const next = options[(at + step + options.length) % options.length];
        if (!next) return;
        onChange(next.value);
        requestAnimationFrame(() => group.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
      }}
    >
      {options.map((option, at) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value || (at === 0 && !options.some((entry) => entry.value === value)) ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
