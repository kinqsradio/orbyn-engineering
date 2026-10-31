import { Network } from "lucide-react";
import { useMemo, useState } from "react";
import type { Thread } from "../../api/types";
import { runStateLabels } from "../../lib/format";
import { navigate } from "../../state/route";
import { useWorkspace } from "../../state/workspace";
import { IconButton } from "../../ui/controls";
import { Menu, type MenuItem } from "../../ui/Menu";

const RELATION: Record<string, string> = { fork: "Fork", side: "Side chat", subagent: "Subagent" };

const status = (thread: Thread) => {
  const state = thread.active_run?.state ?? thread.last_run_state;
  return state ? runStateLabels[state] : "New";
};

/** The thread's parent, its forks and its delegated threads, with where each stands. */
export function relatedThreads(thread: Thread, threads: readonly Thread[]) {
  const parentId = thread.lifecycle?.parent_thread_id ?? null;
  const parent = parentId ? threads.find((entry) => entry.id === parentId) : undefined;
  const children = threads.filter((entry) => entry.lifecycle?.parent_thread_id === thread.id);
  return { parent, children };
}

export function RelatedThreads({ thread }: { thread: Thread }) {
  const threads = useWorkspace((state) => state.threads);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const { parent, children } = useMemo(() => relatedThreads(thread, Object.values(threads)), [thread, threads]);
  if (!parent && children.length === 0) return null;
  const row = (entry: Thread, label: string): MenuItem => ({
    label: `${label}: ${entry.title} (${status(entry)})`,
    onSelect: () => navigate({ name: "thread", id: entry.id }),
  });
  return (
    <>
      <IconButton
        label="Related threads"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <Network size={16} aria-hidden />
      </IconButton>
      {anchor ? (
        <Menu
          x={anchor.x}
          y={anchor.y}
          label="Related threads"
          onClose={() => setAnchor(null)}
          items={[
            ...(parent ? [row(parent, "Parent")] : []),
            ...children.map((child) => row(child, RELATION[child.lifecycle?.relation ?? ""] ?? "Related")),
          ]}
        />
      ) : null}
    </>
  );
}
