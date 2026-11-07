import type { ReactNode } from "react";

export interface DialogFact { label: ReactNode; value: ReactNode; mono?: boolean }

/** The grey card inside a confirm dialog: what goes, one fact per line (s-x-projects-remove, s-x-worktrees-delete, s-x-maint-delete). */
export function DialogCard({ facts }: { facts: DialogFact[] }) {
  return <div className="set-dlg-card">
    {facts.map((fact, at) => <div key={at} className="set-dlg-kv">
      <span>{fact.label}</span>
      <b className={fact.mono ? "mono" : undefined}>{fact.value}</b>
    </div>)}
  </div>;
}
