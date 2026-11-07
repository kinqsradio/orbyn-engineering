import { settingsLabel } from "./settingsSearch";
import { useEffect } from "react";
import { api } from "../../api/client";
import { onShellChange } from "../../api/shell";
import type { ShellAction } from "../../api/types";
import { toFailure, useAsync } from "../../lib/useAsync";
import { useUi } from "../../state/ui";
import { Check, Info } from "lucide-react";
import { Button } from "../../ui/controls";
import { SettingGroup, SettingRow } from "../../ui/SettingRow";

const PERMISSIONS: Record<string, { title: string; missing: string; open: ShellAction }> = {
  accessibility: {
    title: settingsLabel("general-accessibility"),
    missing: "Not granted.",
    open: "open_accessibility_settings",
  },
  screen_recording: {
    title: settingsLabel("general-screen-recording"),
    missing: "Not granted. Needed to capture the screen for a thread.",
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
    <><SettingGroup>
      {cli ? (
        <SettingRow
          title={settingsLabel("general-command-line-tool")}
          description={cli.installed ? `Installed at ${cli.path}.` : `Not installed. Installs orbyn into ${cli.path}.`}
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
          <SettingRow key={permission.id} title={known.title} description={permission.granted ? "Granted by macOS" : known.missing}>
            {permission.granted ? (
              <span className="set-pill"><Check size={13} aria-hidden />Granted</span>
            ) : (
              <>
                <span className="set-pill">Not granted</span>
                <Button small onClick={() => act(known.open)}>
                  Open System Settings
                </Button>
              </>
            )}
          </SettingRow>
        );
      })}
    </SettingGroup>
    <p className="banner"><Info size={13} aria-hidden />macOS asks the first time a thread needs one. Changes in System Settings can need the app to restart.</p>
    </>
  );
}
