import "@fontsource-variable/geist/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { captureToken } from "./api/token";
import { App } from "./app/App";
import { trackInputModality } from "./lib/inputModality";
import { applyTheme, useUi } from "./state/ui";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/thread.css";
import "./styles/pages.css";
import "./styles/layouts.css";

captureToken();
applyTheme(useUi.getState().theme);
trackInputModality();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
