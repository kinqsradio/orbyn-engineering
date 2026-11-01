import type { ReactNode } from "react";

/** One row of a settings group: what it is on the left, its control on the right. */
export function SettingRow({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="setting-line">
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
