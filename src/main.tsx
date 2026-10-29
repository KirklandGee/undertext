import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// The top bar leaves room for the window buttons macOS draws over it.
if (/Mac/.test(navigator.userAgent)) document.documentElement.dataset.mac = "";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
