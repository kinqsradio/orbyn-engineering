import { useId } from "react";
import { useUi, type ThemeChoice } from "../../state/ui";

const choices: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const shortcuts: { keys: string; action: string }[] = [
  { keys: "Enter", action: "Send message" },
  { keys: "Shift+Enter", action: "New line" },
  { keys: "Alt+N", action: "New thread" },
  { keys: "Alt+A", action: "Approvals" },
  { keys: "Alt+1, 2, 3", action: "Diff, Terminal, Activity" },
  { keys: "Esc", action: "Close the top dialog or panel" },
];

export function AppearanceSection() {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const group = useId();
  return (
    <>
      <div className="section-bar">
        <h1 tabIndex={-1} data-page-title>
          Appearance
        </h1>
      </div>
      <fieldset className="fieldset">
        <legend>Theme</legend>
        <div className="choice-row">
          {choices.map((choice) => (
            <label key={choice.value} className="check">
              <input
                type="radio"
                name={group}
                checked={theme === choice.value}
                onChange={() => setTheme(choice.value)}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <section className="section">
        <h2>Keyboard</h2>
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
      </section>
    </>
  );
}
