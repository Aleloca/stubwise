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
  return `
:host {
  --sw-accent: ${accentColor};
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
  padding: 14px 16px;
  flex: 0 0 auto;
}
.sw-header-title { font-size: 15px; font-weight: 600; }
.sw-header-note { font-size: 12px; opacity: 0.85; margin-top: 2px; }

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
.sw-citation {
  font-size: 11px;
  color: var(--sw-muted);
  margin-top: 2px;
  align-self: flex-start;
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
  font-size: 14px;
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
}
.sw-composer-input {
  flex: 1 1 auto;
  border: 1px solid var(--sw-border);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 14px;
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
}
`;
}
