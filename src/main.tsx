import React from "react";
import { createRoot } from "react-dom/client";
// Observatory design system first: view stylesheets load after it and may
// refine it; compact.css is last so its short-viewport rules win.
import "./design/fonts.css";
import "./design/tokens.css";
import "./design/base.css";
import "./design/components.css";
import "./design/shell.css";
import "./design/discover.css";
import "./design/masthead.css";
import "./design/dialogs.css";
import "./design/polish.css";
import "./design/compact.css";
import App from "./App";
import { startPointerLight } from "./pointer-light";
import { watchScrollEdge } from "./scroll-edge";
import { startFigureFit } from "./fit-figures";
import { RenderBoundary } from "./components/WorkspaceBoundary";

startPointerLight();
watchScrollEdge();
startFigureFit();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RenderBoundary label="Hook Radar">
      <App />
    </RenderBoundary>
  </React.StrictMode>,
);
