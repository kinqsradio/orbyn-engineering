const shortcuts: { keys: string; action: string }[] = [
  { keys: "Enter", action: "Send message" },
  { keys: "Shift+Enter", action: "New line" },
  { keys: "Cmd/Ctrl+K", action: "Command palette" },
  { keys: "Alt+N", action: "New thread" },
  { keys: "Alt+1, 2, 3", action: "Diff, Terminal, Activity" },
  { keys: "Esc", action: "Close the top dialog or panel" },
];

export function KeybindingsSection() {
  return (
    <>
      <h1 className="sr-only" tabIndex={-1} data-page-title>
        Keybindings
      </h1>
      <dl className="shortcuts">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.keys}>
            <dt>
              <kbd>{shortcut.keys}</kbd>
            </dt>
            <dd>{shortcut.action}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
