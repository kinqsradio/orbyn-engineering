import "@fontsource-variable/inter/wght.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { captureToken } from "./api/token";
import { App } from "./app/App";
import { applyTheme, useUi } from "./state/ui";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/thread.css";
import "./styles/pages.css";

captureToken();
applyTheme(useUi.getState().theme);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
