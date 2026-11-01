import { createContext, useContext, type ReactNode } from "react";

export const SettingRowIds = createContext<(title: string) => string | undefined>(() => undefined);

/** One row of a settings group: what it is on the left, its control on the right. */
export function SettingRow({
  title,
  settingId: explicitId,
  description,
  actions,
  children,
}: {
  title: string;
  settingId?: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const settingId = useContext(SettingRowIds)(title) ?? explicitId;
  return (
    <div className="setting-line" id={settingId} tabIndex={settingId ? -1 : undefined}>
      <div className="setting-line-text">
        <div className="setting-line-heading">
          <span className="setting-line-title">{title}</span>
          {actions}
        </div>
        {description ? <span className="setting-line-desc">{description}</span> : null}
      </div>
      {children ? <div className="setting-line-control">{children}</div> : null}
    </div>
  );
}

export function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="setting-group">
      <h2>{title}</h2>
      <div className="setting-list">{children}</div>
    </section>
  );
}
