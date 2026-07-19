import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GeneratorApp } from "./GeneratorApp";
import "../web/styles.css";
import "./generator.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GeneratorApp />
  </StrictMode>,
);
