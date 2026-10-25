import React from "react";
import ReactDOM from "react-dom/client";
import Spike from "./Spike";
import "./styles.css";

// The codemirror branch boots into the new editor. App.tsx still holds the
// ProseMirror app, to port from.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Spike />
  </React.StrictMode>,
);
