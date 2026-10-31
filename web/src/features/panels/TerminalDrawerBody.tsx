import { Columns2, Play, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { request } from "../../api/client";
import type { ProjectFileView, TerminalInfo } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { IconButton } from "../../ui/controls";
import { Menu } from "../../ui/Menu";
import { TerminalPanel } from "./TerminalPanel";

const MAIN = "main";
const q = encodeURIComponent;

export function groupTerminals(terminals: readonly TerminalInfo[]): TerminalInfo[][] {
  const groups = new Map<string, TerminalInfo[]>();
  for (const terminal of terminals) groups.set(terminal.group, [...(groups.get(terminal.group) ?? []), terminal]);
  return [...groups.values()];
}

/** Terminal tabs, each a group of splits, and the project's scripts. */
export function TerminalDrawerBody({ threadId }: { threadId: string }) {
  const base = `/api/threads/${q(threadId)}`;
  const terminals = useAsync(`terminals:${threadId}`, (signal) =>
    request<TerminalInfo[]>("GET", `${base}/terminals`, undefined, signal),
  );
  const scripts = useAsync(`scripts:${threadId}`, (signal) =>
    request<ProjectFileView>("GET", `${base}/scripts`, undefined, signal),
  );
  const [active, setActive] = useState(MAIN);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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
    if (active !== MAIN && terminals.status === "ready" && !shown) setActive(MAIN);
  }, [active, shown, terminals.status]);

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
  const run = async (name: string) => {
    try {
      const made = await request<TerminalInfo>("POST", `${base}/scripts`, { name });
      setActive(made.group);
      reload();
    } catch (failure) {
      fail(failure);
    }
  };
  const scriptList = (scripts.data?.file as { scripts?: { name: string }[] } | null | undefined)?.scripts ?? [];
  const onKey = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d" && shown?.[0]) {
      event.preventDefault();
      void open({ split_of: shown[0].id, direction: event.shiftKey ? "vertical" : "horizontal" });
    }
  };

  return (
    <div className="terminal-drawer-body" onKeyDownCapture={onKey}>
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
        <IconButton label="New terminal" onClick={() => void open({})}>
          <Plus size={14} aria-hidden />
        </IconButton>
        {terminals.data ? (
          <IconButton label="Split terminal" onClick={() => void open({ split_of: shown?.[0]?.id ?? MAIN, direction: "horizontal" })}>
            <Columns2 size={14} aria-hidden />
          </IconButton>
        ) : null}
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
      </div>
      <div className="terminal-splits" data-direction={shown?.[1]?.direction ?? undefined}>
        {shown ? (
          shown.map((terminal) => (
            <TerminalPanel
              key={terminal.id}
              threadId={threadId}
              {...(terminal.id === MAIN ? {} : { terminalId: terminal.id })}
            />
          ))
        ) : (
          <TerminalPanel threadId={threadId} />
        )}
      </div>
      {menu ? (
        <Menu
          {...menu}
          label="Scripts"
          onClose={() => setMenu(null)}
          items={scriptList.map((script) => ({ label: script.name, onSelect: () => void run(script.name) }))}
        />
      ) : null}
    </div>
  );
}
