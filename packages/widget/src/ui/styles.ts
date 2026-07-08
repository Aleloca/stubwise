/**
 * CSS del widget come stringa, iniettato in un `<style>` dentro lo Shadow DOM.
 * L'isolamento dello shadow root ci protegge dallo stile del sito ospite (e
 * viceversa): non servono reset globali né `!important`. Tutte le classi sono
 * prefissate `sw-` per chiarezza (anche se lo shadow root le confinerebbe già).
 *
 * Estetica: sobria, sans di sistema, un solo colore d'accento (dal config,
 * iniettato come variabile `--sw-accent`). Nessuna dipendenza esterna.
 *
 * @param accentColor colore d'accento del progetto (bolla, header, bottoni).
 */
export function widgetStyles(accentColor: string): string {
  // Sanitizzazione difensiva: la config viene dal server, ma il colore finisce
  // interpolato grezzo dentro un `<style>` — accettiamo solo un hex, altrimenti
  // ripieghiamo sul default (nessuna iniezione di CSS arbitrario).
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(accentColor) ? accentColor : "#3b82f6";
  return `
:host {
  --sw-accent: ${accent};
  --sw-bg: #ffffff;
  --sw-fg: #1a1a1a;
  --sw-muted: #6b7280;
  --sw-border: #e5e7eb;
  --sw-panel-bg: #f9fafb;
  all: initial;
}

.sw-root, .sw-root * {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

/* Bolla lanciatrice, fissa in basso a destra. */
.sw-bubble {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  background: var(--sw-accent);
  color: #fff;
  cursor: pointer;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.24);
  font-size: 24px;
  line-height: 1;
  padding: 0;
}
.sw-bubble:hover { filter: brightness(1.05); }

/* Pannello chat. */
.sw-panel {
  position: fixed;
  bottom: 88px;
  right: 20px;
  width: 380px;
  height: 600px;
  max-height: calc(100vh - 108px);
  background: var(--sw-bg);
  color: var(--sw-fg);
  border: 1px solid var(--sw-border);
  border-radius: 12px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.18);
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sw-header {
  background: var(--sw-accent);
  color: #fff;
  padding: 12px 14px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.sw-header-text { flex: 1 1 auto; min-width: 0; }
.sw-header-title { font-size: 15px; font-weight: 600; }
.sw-header-note { font-size: 12px; opacity: 0.85; margin-top: 2px; }
/* Contenitore dei bottoni header: li tiene sulla stessa riga, centrati tra loro
   e (via align-items:center sul .sw-header) rispetto al blocco titolo. */
.sw-header-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-right: -4px;
}
/* Base comune ai bottoni header: touch target quadrato, glifo centrato dentro
   il bottone (flex center → niente offset da line-height). */
.sw-header-btn {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #fff;
  cursor: pointer;
  /* Il glifo ⟳ ha metriche più piccole della ✕: font-size maggiorato sulla
     base (usata dal reset) e ridotto sulla close per pareggiare la resa. */
  font-size: 22px;
  line-height: 1;
  padding: 0;
  opacity: 0.9;
}
.sw-header-btn:hover { opacity: 1; background: rgba(255, 255, 255, 0.14); }
/* "Nuova conversazione": conferma inline two-step, nello stato armato ("?") si
   evidenzia. */
.sw-header-newchat--confirm {
  opacity: 1;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.22);
}
/* X di chiusura: leva primaria su mobile fullscreen (la bolla è nascosta),
   sempre presente anche su desktop. Font-size più basso della base: la ✕
   rende otticamente più grande del ⟳ a parità di corpo. */
.sw-header-close { font-size: 20px; }

.sw-messages {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sw-msg {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}
.sw-msg-user {
  align-self: flex-end;
  background: var(--sw-accent);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.sw-msg-assistant {
  align-self: flex-start;
  background: var(--sw-panel-bg);
  color: var(--sw-fg);
  border: 1px solid var(--sw-border);
  border-bottom-left-radius: 4px;
}

/* Markdown renderizzato dentro un messaggio assistant. Spaziatura sobria: i
   blocchi non devono introdurre margini a inizio/fine bolla. */
.sw-msg-assistant .sw-md-p,
.sw-msg-assistant .sw-md-heading,
.sw-msg-assistant .sw-md-list,
.sw-msg-assistant .sw-md-pre { margin: 0 0 8px; }
.sw-msg-assistant > .sw-md-p:last-child,
.sw-msg-assistant > .sw-md-heading:last-child,
.sw-msg-assistant > .sw-md-list:last-child,
.sw-msg-assistant > .sw-md-pre:last-child { margin-bottom: 0; }
.sw-msg-assistant .sw-md-heading { font-size: 14px; }
.sw-msg-assistant .sw-md-list { padding-left: 20px; }
.sw-msg-assistant .sw-md-list li { margin: 2px 0; }
.sw-msg-assistant code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 4px;
  padding: 1px 4px;
}
.sw-msg-assistant .sw-md-pre {
  background: rgba(0, 0, 0, 0.06);
  border-radius: 8px;
  padding: 8px 10px;
  overflow-x: auto;
}
.sw-msg-assistant .sw-md-pre code {
  background: none;
  padding: 0;
  white-space: pre;
}
.sw-msg-assistant a {
  color: var(--sw-accent);
  text-decoration: underline;
  word-break: break-all;
}

/* Card ticket. */
.sw-card {
  align-self: stretch;
  border: 1px solid var(--sw-border);
  border-radius: 10px;
  padding: 12px;
  background: var(--sw-panel-bg);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sw-badge {
  align-self: flex-start;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--sw-accent);
  color: #fff;
}
.sw-input, .sw-textarea {
  width: 100%;
  border: 1px solid var(--sw-border);
  border-radius: 8px;
  padding: 8px 10px;
  /* 16px: sotto i 16px iOS Safari zooma la pagina al focus (non controlliamo il
     viewport meta della pagina ospite: il font-size è l'unica leva affidabile). */
  font-size: 16px;
  color: var(--sw-fg);
  background: #fff;
}
.sw-textarea { resize: vertical; min-height: 72px; }
.sw-card-actions { display: flex; gap: 8px; }
.sw-card-msg { font-size: 12px; color: #b91c1c; }
.sw-card-confirmed { font-size: 14px; font-weight: 600; color: #15803d; }

/* Composer. */
.sw-composer {
  flex: 0 0 auto;
  border-top: 1px solid var(--sw-border);
  padding: 10px;
  display: flex;
  gap: 8px;
  align-items: flex-end;
  /* Riduce il delay del tap su mobile (no double-tap-to-zoom sul composer). */
  touch-action: manipulation;
}
.sw-composer-input {
  flex: 1 1 auto;
  border: 1px solid var(--sw-border);
  border-radius: 8px;
  padding: 8px 10px;
  /* 16px per evitare l'auto-zoom di iOS Safari al focus (vedi .sw-input). */
  font-size: 16px;
  resize: none;
  max-height: 96px;
  color: var(--sw-fg);
  background: #fff;
}
.sw-composer-note {
  flex: 1 1 auto;
  font-size: 12px;
  color: var(--sw-muted);
  padding: 8px 4px;
}

.sw-btn {
  border: none;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  background: var(--sw-accent);
  color: #fff;
}
.sw-btn:disabled { opacity: 0.5; cursor: default; }
.sw-btn-secondary {
  background: transparent;
  color: var(--sw-fg);
  border: 1px solid var(--sw-border);
}

/* Full-screen sotto 480px. */
@media (max-width: 480px) {
  .sw-panel {
    inset: 0;
    width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
    border: none;
  }
  /* Col pannello fullscreen aperto, la bolla flottante (che diventa "X") si
     sovrapporrebbe al bottone d'invio del composer (entrambi bottom-right): la
     nascondiamo e la chiusura passa dalla X nell'header. */
  .sw-bubble--hidden { display: none; }
  /* Touch target generosi su mobile (44x44, standard iOS): il ⟳ prende il
     corpo maggiorato della base, la ✕ resta un filo sotto per pareggiare la
     resa ottica dei due glifi. */
  .sw-header-btn { width: 44px; height: 44px; font-size: 26px; }
  .sw-header-close { font-size: 24px; }
  .sw-header-actions { gap: 4px; }
}
`;
}
