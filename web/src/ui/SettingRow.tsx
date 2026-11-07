import { createContext, useContext, type ReactNode } from "react";

export const SettingRowIds = createContext<(title: string) => string | undefined>(() => undefined);

/** One row of a settings group: what it is on the left, its control on the right. */
export function SettingRow({
  title,
  settingId: explicitId,
  description,
  actions,
  stacked,
  children,
}: {
  title: string;
  settingId?: string;
  description?: string;
  actions?: ReactNode;
  /** Puts the control under the label, for one that needs the full width. */
  stacked?: boolean;
  children?: ReactNode;
}) {
  const settingId = useContext(SettingRowIds)(title) ?? explicitId;
  return (
    <div className={stacked ? "setting-line setting-line-stacked" : "setting-line"} id={settingId} tabIndex={settingId ? -1 : undefined}>
      <div className="setting-line-text">
        <div className="setting-line-heading">
          <span className="setting-line-title">{title}</span>
        </div>
        {description ? <span className="setting-line-desc">{description}</span> : null}
      </div>
      {children || actions ? <div className="setting-line-control">{actions}{children}</div> : null}
    </div>
  );
}

/** A group of rows. With no title the rows stand alone, as the settings frames draw them. */
export function SettingGroup({ title, description, children }: { title?: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="setting-group">
      {title ? <h2>{title}</h2> : null}
      {description ? <div className="setting-group-desc">{description}</div> : null}
      <div className="setting-list">{children}</div>
    </section>
  );
}
