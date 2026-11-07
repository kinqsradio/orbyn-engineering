import type { ReactNode } from "react";

export const UNAVAILABLE_REASON = "Available with Orbyn accounts";

/** Spread onto every control of a platform screen: disabled, with the reason for everyone. */
export const unavailable = {
  disabled: true,
  "aria-disabled": true,
  "aria-description": UNAVAILABLE_REASON,
  title: UNAVAILABLE_REASON,
} as const;

/** The visible reason, shown once at the top of each screen. */
export function SampleNotice() {
  return (
    <p className="platform-notice" role="note">
      <strong>Sample data.</strong> {UNAVAILABLE_REASON}.
    </p>
  );
}

/** A window frame like the app's, for screens drawn inside it. */
export function PlatformFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="platform-stage">
      <div className="platform-frame">
        <div className="platform-titlebar">
          <b>Orbyn</b>
          <span>{title}</span>
        </div>
        <SampleNotice />
        <div className="platform-body">{children}</div>
      </div>
    </div>
  );
}
