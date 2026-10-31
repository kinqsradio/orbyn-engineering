import { Ellipsis } from "lucide-react";
import { use, useState } from "react";
import { request } from "../../api/client";
import { toFailure } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Dialog } from "../../ui/Dialog";
import { Button, IconButton, Pill } from "../../ui/controls";
import { Menu } from "../../ui/Menu";
import { TimelineThread } from "./items";
import { Markdown } from "./Markdown";
import { planFilename, planTitle, stripPlanTitle } from "./proposedPlan";

const COLLAPSE_CHARS = 900;
const COLLAPSE_LINES = 20;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function SaveDialog({ threadId, text, name, onClose }: { threadId: string; text: string; name: string; onClose(): void }) {
  const [path, setPath] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pushToast = useUi((state) => state.pushToast);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await request("PUT", `/api/threads/${encodeURIComponent(threadId)}/files/content`, {
        path: path.trim(),
        content: text,
        base_revision: null,
      });
      pushToast(`Saved ${path.trim()}`);
      onClose();
    } catch (failure) {
      setError(`Couldn't save the plan. ${toFailure(failure).message}`);
      setSaving(false);
    }
  };
  return (
    <Dialog
      title="Save plan to workspace"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving || !path.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <label className="field">
        <span>Path</span>
        <input value={path} onChange={(event) => setPath(event.target.value)} />
      </label>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** A plan the agent proposed: long ones start clipped, and it can leave the thread. */
export function PlanCard({ text }: { text: string }) {
  const threadId = use(TimelineThread);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const pushToast = useUi((state) => state.pushToast);
  const title = planTitle(text) ?? "Proposed plan";
  const name = planFilename(text);
  const collapsible = text.length > COLLAPSE_CHARS || text.split("\n").length > COLLAPSE_LINES;
  const clipped = collapsible && !expanded;
  return (
    <section className="plan-card" aria-label="Proposed plan">
      <header>
        <Pill>Plan</Pill>
        <strong>{title}</strong>
        <IconButton
          label="Plan actions"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setMenu({ x: box.right - 200, y: box.bottom + 4 });
          }}
        >
          <Ellipsis size={14} aria-hidden />
        </IconButton>
      </header>
      <div className="plan-card-body" data-clipped={clipped || undefined}>
        <Markdown text={stripPlanTitle(text)} />
      </div>
      {collapsible ? (
        <Button small tone="quiet" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Collapse plan" : "Expand plan"}
        </Button>
      ) : null}
      {menu ? (
        <Menu
          x={menu.x}
          y={menu.y}
          label="Plan actions"
          onClose={() => setMenu(null)}
          items={[
            {
              label: "Copy plan",
              onSelect: () => void navigator.clipboard?.writeText(text).then(() => pushToast("Copied plan")),
            },
            { label: "Download as markdown", onSelect: () => download(name, text) },
            ...(threadId ? [{ label: "Save to workspace", onSelect: () => setSaving(true) }] : []),
          ]}
        />
      ) : null}
      {saving && threadId ? <SaveDialog threadId={threadId} text={text} name={name} onClose={() => setSaving(false)} /> : null}
    </section>
  );
}
