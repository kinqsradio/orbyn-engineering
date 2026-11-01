import { useCommand } from "../../app/shortcuts";
import { Columns2, Eye, Play, Plus, Rows2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { request } from "../../api/client";
import type { ProjectFileView, TerminalInfo } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { IconButton } from "../../ui/controls";
import { Menu } from "../../ui/Menu";
import { TerminalPanel } from "./TerminalPanel";
import type { ProjectScript } from "../../generated/ProjectScript";
import { openActionPreview } from "../thread/actionPreview";
import { ProjectActionIcon } from "../../ui/ProjectActionIcon";

const MAIN = "main";
const q = encodeURIComponent;

export function groupTerminals(terminals: readonly TerminalInfo[]): TerminalInfo[][] {
  const groups = new Map<string, TerminalInfo[]>();
  for (const terminal of terminals) groups.set(terminal.group, [...(groups.get(terminal.group) ?? []), terminal]);
  return [...groups.values()];
}

/** Terminal tabs, each a group of splits, and the project's scripts. */
export function TerminalDrawerBody({ threadId, onClose }: { threadId: string; onClose(): void }) {
  const base = `/api/threads/${q(threadId)}`;
  const terminals = useAsync(`terminals:${threadId}`, (signal) =>
    request<TerminalInfo[]>("GET", `${base}/terminals`, undefined, signal),
  );
  const scripts = useAsync(`scripts:${threadId}`, (signal) =>
    request<ProjectFileView>("GET", `${base}/scripts`, undefined, signal),
  );
  const [active, setActive] = useState(MAIN);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [watching, setWatching] = useState(false);
  const pushToast = useUi((state) => state.pushToast);
  const { reload } = terminals;
  const groups = useMemo(() => groupTerminals(terminals.data ?? []), [terminals.data]);
  const shown = groups.find((group) => group[0]?.group === active);
  const tabs = groups.filter((group) => group[0]?.group !== MAIN);
  const fail = useCallback(
    (failure: unknown) => pushToast(`Couldn't do that. ${toFailure(failure).message}`),
    [pushToast],
  );

  useEffect(() => {
    if (active !== MAIN && terminals.status === "ready" && !terminals.refreshing && !shown) setActive(MAIN);
  }, [active, shown, terminals.status, terminals.refreshing]);

  const open = async (body: Record<string, string>) => {
    try {
      const made = await request<TerminalInfo>("POST", `${base}/terminals`, body);
      setActive(made.group);
      reload();
    } catch (failure) {
      fail(failure);
    }
  };
  const close = async (terminal: TerminalInfo) => {
    try {
      await request("DELETE", `${base}/terminals/${q(terminal.id)}`);
      reload();
    } catch (failure) {
      fail(failure);
    }
  };
  const run = async (script: ProjectScript) => {
    try {
      const made = await request<TerminalInfo>("POST", `${base}/scripts`, { name: script.name });
      setActive(made.group);
      reload();
      await openActionPreview(threadId, script);
    } catch (failure) {
      fail(failure);
    }
  };
  const split = (direction: "horizontal" | "vertical") => void open({ split_of: shown?.[0]?.id ?? MAIN, direction });
  useCommand("terminal.split", () => split("horizontal"));
  useCommand("terminal.splitVertical", () => split("vertical"));
  useCommand("terminal.new", () => void open({}));
  useCommand("terminal.close", () => {
    const first = shown?.[0];
    if (first && first.id !== MAIN) void close(first);
    else onClose();
  });
  const scriptList = scripts.data?.scripts ?? [];
  return (
    <div className="terminal-drawer-body">
      <div className="terminal-tabs" role="tablist" aria-label="Terminals">
        <button type="button" role="tab" aria-selected={active === MAIN} onClick={() => setActive(MAIN)}>
          Terminal
        </button>
        {tabs.map((group) => {
          const first = group[0];
          if (!first) return null;
          return (
            <span key={first.group} className="terminal-tab" data-selected={first.group === active || undefined}>
              <button type="button" role="tab" aria-selected={first.group === active} onClick={() => setActive(first.group)}>
                {first.title}
                {group.length > 1 ? ` (${group.length})` : ""}
              </button>
              <button type="button" aria-label={`Close ${first.title}`} onClick={() => void close(first)}>
                <X size={12} aria-hidden />
              </button>
            </span>
          );
        })}
        <span className="terminal-tabs-gap" />
        {terminals.data ? (
          <>
            <IconButton
              label="Split terminal horizontally"
              onClick={() => split("horizontal")}
            >
              <Columns2 size={14} aria-hidden />
            </IconButton>
            <IconButton
              label="Split terminal vertically"
              onClick={() => split("vertical")}
            >
              <Rows2 size={14} aria-hidden />
            </IconButton>
          </>
        ) : null}
        <IconButton label="Watch only" pressed={watching} onClick={() => setWatching(!watching)}>
          <Eye size={14} aria-hidden />
        </IconButton>
        <IconButton label="New terminal" onClick={() => void open({})}>
          <Plus size={14} aria-hidden />
        </IconButton>
        {scriptList.length > 0 ? (
          <IconButton
            label="Run a script"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.top - 8 - scriptList.length * 30 });
            }}
          >
            <Play size={14} aria-hidden />
          </IconButton>
        ) : null}
        <IconButton label="Close terminal" onClick={onClose}>
          <X size={14} aria-hidden />
        </IconButton>
      </div>
      <div className="terminal-splits" data-direction={shown?.[1]?.direction ?? undefined}>
        {shown ? (
          shown.map((terminal) => (
            <TerminalPanel
              key={terminal.id}
              threadId={threadId}
              observe={watching}
              {...(terminal.id === MAIN ? {} : { terminalId: terminal.id })}
            />
          ))
        ) : (
          <TerminalPanel threadId={threadId} observe={watching} />
        )}
      </div>
      {menu ? (
        <Menu
          {...menu}
          label="Scripts"
          onClose={() => setMenu(null)}
          items={scriptList.map((script) => ({ label: script.name, icon: <ProjectActionIcon icon={script.icon} />, onSelect: () => void run(script) }))}
        />
      ) : null}
    </div>
  );
}
