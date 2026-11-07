import type { ReactNode } from "react";
import "./PageBar.css";
import { NarrowBack } from "./states";

/** The heading line of a page: its title and sub line on the left, its actions on the right. */
export function PageBar({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <header className="topbar page-bar">
      <NarrowBack />
      <div className="crumbs">{children}</div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
