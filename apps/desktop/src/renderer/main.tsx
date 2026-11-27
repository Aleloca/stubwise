// PRIMO import in assoluto: nella build web cattura le primitive della
// cassaforte prima di qualunque altro codice (design della cassaforte nel
// browser §2.4); altrove è un modulo vuoto.
import "@backend/vault-boot";
import "./csp-init";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root mancante in index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
