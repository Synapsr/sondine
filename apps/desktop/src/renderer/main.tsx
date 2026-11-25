import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { installOsLocale } from "./i18n/locale";
import "./styles.css";

installOsLocale(window.sondine.info.locale);

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
