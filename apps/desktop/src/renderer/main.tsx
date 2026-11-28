// PRIMO import in assoluto: nella build web cattura le primitive della
// cassaforte prima di qualunque altro codice (design della cassaforte nel
// browser §2.4); altrove è un modulo vuoto. Il suo primo import è a sua volta
// `./csp-init` (Zod senza eval), che qui sotto torna come import già valutato
// per le build senza cassaforte nel browser.
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
