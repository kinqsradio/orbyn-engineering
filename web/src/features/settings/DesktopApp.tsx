import { settingsLabel } from "./settingsSearch";
import { useEffect } from "react";
import { api } from "../../api/client";
import { onShellChange } from "../../api/shell";
import type { ShellAction } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Button, Pill } from "../../ui/controls";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

const PERMISSIONS: Record<string, { title: string; description: string; open: ShellAction }> = {
  accessibility: {
    title: settingsLabel("general-accessibility"),
    description: "Lets agents use your computer, when you allow it.",
    open: "open_accessibility_settings",
  },
  screen_recording: {
    title: settingsLabel("general-screen-recording"),
    description: "Lets agents see your screen, when you allow it.",
    open: "open_screen_recording_settings",
  },
};

/** What only the desktop app can do. Nothing shows on a plain server. */
export function DesktopApp() {
  const status = useAsync("shell-status", (signal) => api.shell(signal));
  const pushToast = useUi((state) => state.pushToast);
  const reload = status.reload;
  useEffect(() => onShellChange(reload), [reload]);
  if (!status.data?.attached) return null;
  const { cli, permissions } = status.data.facts;
  const act = (action: ShellAction) => {
    api.shellAction(action).catch((failure: unknown) => pushToast(toFailure(failure).message));
  };
  return (
    <SettingGroup title="Desktop app">
      {cli ? (
        <SettingRow
          title={settingsLabel("general-command-line-tool")}
          description={cli.installed ? `Installed at ${cli.path}.` : `Installs orbyn at ${cli.path}. That folder needs to be on your PATH.`}
        >
          <Button small onClick={() => act(cli.installed ? "remove_cli" : "install_cli")}>
            {cli.installed ? "Remove" : "Install"}
          </Button>
        </SettingRow>
      ) : null}
      {permissions.map((permission) => {
        const known = PERMISSIONS[permission.id];
        if (!known) return null;
        return (
          <SettingRow key={permission.id} title={known.title} description={known.description}>
            {permission.granted ? (
              <Pill>Allowed</Pill>
            ) : (
              <Button small onClick={() => act(known.open)}>
                Open System Settings
              </Button>
            )}
          </SettingRow>
        );
      })}
    </SettingGroup>
  );
}
