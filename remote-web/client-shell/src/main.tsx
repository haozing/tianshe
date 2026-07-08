import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { installDoudianTaskRunner, isDoudianTaskRunnerRoute } from "./domain/doudian/taskRunner";

const root = document.getElementById("app");

if (!root) {
  throw new Error("#app root is missing");
}

if (isDoudianTaskRunnerRoute()) {
  installDoudianTaskRunner();
  root.dataset.doudianTaskRunner = "ready";
  root.textContent = "Doudian task runner ready";
} else {
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
