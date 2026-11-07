import { CloudOff, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/** The strip the settings frames draw for a failure or a state: a message, with actions at the end (.banner, .banner.err in the design). */
export function SettingsBanner({ tone, children, actions }: { tone?: "err"; children: ReactNode; actions?: ReactNode }) {
  return <div className={tone === "err" ? "set-banner err" : "set-banner"} role={tone === "err" ? "alert" : "status"}>
    {tone === "err" ? <TriangleAlert size={16} aria-hidden /> : <CloudOff size={16} aria-hidden />}
    <div>{children}</div>
    {actions ? <div className="set-banner-end">{actions}</div> : null}
  </div>;
}

/** An empty list, said in words: a heading and one line (.empty in the design). */
export function SettingsEmpty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="set-empty"><h3>{title}</h3><p>{children}</p></div>;
}
