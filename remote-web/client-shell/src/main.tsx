import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";

const root = document.getElementById("app");

if (!root) {
  throw new Error("#app root is missing");
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
