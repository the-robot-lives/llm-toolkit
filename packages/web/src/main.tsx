// 〚📁:6a21e625-3d1c-5ec4-a4be-fbc1990d2e80〛 Web entrypoint :: SPA bootstrap — router, providers, Mac host bridge.

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import "./index.css";
import "katex/dist/katex.min.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
