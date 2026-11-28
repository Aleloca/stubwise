// La pagina a sé della cassaforte (revisione della fase 2, I-2): il PRIMO
// import cattura le primitive della cassaforte e avvia il worker (design
// §2.4); il suo primo import è `csp-init` (Zod senza eval). Poi solo React,
// le lingue, gli stili e le pagine della cassaforte: niente dell'app.
import "../data/backend/real/vaultBrowser/boot";
import "../csp-init";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n";
import "../styles/index.css";
import { VaultPageApp } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("#root mancante in vault.html");

createRoot(root).render(
  <StrictMode>
    <VaultPageApp />
  </StrictMode>,
);
