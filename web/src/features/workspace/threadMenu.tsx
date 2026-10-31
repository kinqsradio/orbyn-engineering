import {
  Archive,
  CircleCheck,
  Clock,
  Copy,
  Folder,
  FolderTree,
  GitBranch,
  Hash,
  MailOpen,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Settings,
  SlidersHorizontal,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { Thread } from "../../api/types";
import type { SnoozePreset } from "../../generated/SnoozePreset";
import { navigate } from "../../state/route";
import { Button, Field } from "../../ui/controls";
import { Dialog } from "../../ui/Dialog";
import type { MenuItem } from "../../ui/Menu";
import {
  archiveThreads,
  copyText,
  pinThreads,
  regenerateTitles,
  setAutoSettle,
  setUnread,
  settleThreads,
  snoozeThreads,
  unpinThreads,
  unsettleThreads,
  wakeThreads,
} from "./threadActions";

const icon = (Glyph: typeof Pin) => <Glyph size={14} aria-hidden />;

const whenLabel = (at: Date) =>
  at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

export function snoozeChildren(
  threads: readonly Thread[],
  presets: readonly SnoozePreset[],
  onCustom: () => void,
): MenuItem[] {
  return [
    ...presets.map((preset) => {
      const until = new Date(Date.now() + preset.minutes * 60_000);
      return {
        label: `${preset.label} (${whenLabel(until)})`,
        onSelect: () => void snoozeThreads(threads, new Date(Date.now() + preset.minutes * 60_000)),
      };
    }),
    { label: "Custom…", separatorBefore: true, onSelect: onCustom },
  ];
}

export interface ThreadMenuInput {
  thread: Thread;
  branch: string | null;
  projectName: string;
  filterActive: boolean;
  presets: readonly SnoozePreset[];
  onRename(): void;
  onCustomSnooze(threads: Thread[]): void;
  onDelete(threads: Thread[]): void;
  onFilter(): void;
}

export function threadMenuItems(input: ThreadMenuInput): MenuItem[] {
  const { thread, branch, presets } = input;
  const lifecycle = thread.lifecycle;
  const running = thread.active_run !== null;
  const snoozed = Boolean(lifecycle?.snoozed_until);
  return [
    ...(branch && !thread.worktree
      ? [
          {
            label: `New thread on ${branch}`,
            icon: icon(SquarePen),
            onSelect: () => navigate({ name: "new", projectId: thread.project_id }),
          },
        ]
      : []),
    lifecycle?.pinned_at
      ? { label: "Unpin thread", icon: icon(PinOff), onSelect: () => void unpinThreads([thread]) }
      : { label: "Pin thread", icon: icon(Pin), onSelect: () => void pinThreads([thread]) },
    lifecycle?.settled_at
      ? { label: "Un-settle thread", icon: icon(CircleCheck), onSelect: () => void unsettleThreads([thread]) }
      : { label: "Settle thread", icon: icon(CircleCheck), onSelect: () => void settleThreads([thread]) },
    snoozed
      ? { label: "Wake thread", icon: icon(Clock), onSelect: () => void wakeThreads([thread]) }
      : {
          label: "Snooze",
          icon: icon(Clock),
          children: snoozeChildren([thread], presets, () => input.onCustomSnooze([thread])),
        },
    { label: "Rename thread", icon: icon(Pencil), separatorBefore: true, onSelect: input.onRename },
    { label: "Regenerate title", icon: icon(RefreshCw), onSelect: () => void regenerateTitles([thread]) },
    { label: "Mark unread", icon: icon(MailOpen), onSelect: () => void setUnread([thread], true) },
    {
      label: input.filterActive ? "Show all projects" : `Filter by ${input.projectName}`,
      icon: icon(FolderTree),
      onSelect: input.onFilter,
    },
    {
      label: "Auto-settle behavior",
      icon: icon(SlidersHorizontal),
      children: [
        {
          label: "Enabled",
          selected: lifecycle?.auto_settle !== false,
          onSelect: () => void setAutoSettle(thread, "enabled"),
        },
        {
          label: "Disabled",
          selected: lifecycle?.auto_settle === false,
          onSelect: () => void setAutoSettle(thread, "disabled"),
        },
      ],
    },
    {
      label: "Copy",
      icon: icon(Copy),
      separatorBefore: true,
      children: [
        { label: "Path", icon: icon(Folder), onSelect: () => void copyText(thread.cwd, "Copied path") },
        ...(branch
          ? [{ label: "Branch", icon: icon(GitBranch), onSelect: () => void copyText(branch, "Copied branch") }]
          : []),
        { label: "Thread ID", icon: icon(Hash), onSelect: () => void copyText(thread.id, "Copied thread ID") },
      ],
    },
    {
      label: "Project settings",
      icon: icon(Settings),
      onSelect: () => navigate({ name: "settings", section: "projects" }),
    },
    {
      label: "Archive thread",
      icon: icon(Archive),
      separatorBefore: true,
      disabled: running,
      onSelect: () => void archiveThreads([thread]),
    },
    {
      label: "Delete",
      icon: icon(Trash2),
      destructive: true,
      disabled: running,
      onSelect: () => input.onDelete([thread]),
    },
  ];
}

export function bulkMenuItems(
  threads: Thread[],
  presets: readonly SnoozePreset[],
  onCustomSnooze: (threads: Thread[]) => void,
  onDelete: (threads: Thread[]) => void,
): MenuItem[] {
  const count = threads.length;
  const pinned = threads.filter((thread) => thread.lifecycle?.pinned_at);
  const settling = threads.filter((thread) => !thread.lifecycle?.settled_at);
  return [
    ...(pinned.length > 0
      ? [{ label: `Unpin (${pinned.length})`, onSelect: () => void unpinThreads(pinned) }]
      : []),
    { label: `Settle (${count})`, disabled: settling.length === 0, onSelect: () => void settleThreads(settling) },
    {
      label: `Snooze (${count})`,
      children: snoozeChildren(threads, presets, () => onCustomSnooze(threads)),
    },
    { label: `Regenerate titles (${count})`, onSelect: () => void regenerateTitles(threads) },
    { label: `Mark unread (${count})`, onSelect: () => void setUnread(threads, true) },
    {
      label: `Delete (${count})`,
      destructive: true,
      disabled: threads.some((thread) => thread.active_run !== null),
      onSelect: () => onDelete(threads),
    },
  ];
}

const pad = (value: number) => String(value).padStart(2, "0");

const localInput = (at: Date) =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;

export function CustomSnoozeDialog({ threads, onClose }: { threads: Thread[]; onClose(): void }) {
  const [mode, setMode] = useState<"time" | "duration">("time");
  const [time, setTime] = useState(() => localInput(new Date(Date.now() + 3_600_000)));
  const [hours, setHours] = useState("1");
  const until = mode === "time" ? new Date(time) : new Date(Date.now() + Number(hours) * 3_600_000);
  const valid = !Number.isNaN(until.getTime()) && until.getTime() > Date.now();
  return (
    <Dialog
      title="Custom snooze"
      onClose={onClose}
      footer={
        <>
          <Button tone="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            tone="primary"
            disabled={!valid}
            onClick={() => {
              void snoozeThreads(threads, until);
              onClose();
            }}
          >
            Snooze
          </Button>
        </>
      }
    >
      <div className="route-tabs" role="tablist" aria-label="Schedule type">
        {(["time", "duration"] as const).map((entry) => (
          <button key={entry} type="button" role="tab" aria-selected={mode === entry} onClick={() => setMode(entry)}>
            {entry === "time" ? "Date and time" : "Duration"}
          </button>
        ))}
      </div>
      {mode === "time" ? (
        <Field label="Wake at">
          {(props) => (
            <input {...props} type="datetime-local" value={time} onChange={(event) => setTime(event.target.value)} />
          )}
        </Field>
      ) : (
        <Field label="Hours">
          {(props) => (
            <input
              {...props}
              type="number"
              min="1"
              max="720"
              value={hours}
              onChange={(event) => setHours(event.target.value)}
            />
          )}
        </Field>
      )}
    </Dialog>
  );
}
