/**
 * Root del widget: bolla lanciatrice + pannello chat. Monta il tutto in uno
 * Shadow DOM (isolamento dallo stile del sito ospite) tramite {@link mountWidget}.
 *
 * La bolla è sempre visibile; il click apre/chiude il pannello e la bolla
 * diventa un "chiudi". Lo stato di storico/stream vive dentro {@link Chat}: il
 * pannello si smonta/rimonta all'apri/chiudi, quindi lo storico si ricarica
 * dallo storage a ogni apertura (comportamento voluto: sempre coerente col
 * server, nessuno stato appeso).
 */
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { WidgetApiBase, WidgetConfig, WidgetUser } from "../core/api.js";
import { getConversationId } from "../core/storage.js";
import { getStrings } from "../i18n.js";
import { Chat } from "./chat.js";
import { widgetStyles } from "./styles.js";

/** Timeout (ms) dopo cui la conferma inline "nuova conversazione" si annulla. */
const NEW_CHAT_CONFIRM_MS = 3000;

/** Config nella variante ATTIVA (l'unica per cui si monta la UI). */
type ActiveConfig = Extract<WidgetConfig, { enabled: true }>;

export interface WidgetRootProps {
  base: WidgetApiBase;
  config: ActiveConfig;
  user: WidgetUser;
}

export function WidgetRoot({ base, config, user }: WidgetRootProps) {
  const [open, setOpen] = useState(false);
  // Conferma inline two-step del bottone "nuova conversazione": un primo click
  // arma la conferma (il bottone diventa "confermi?"), il secondo resetta. Un
  // tap accidentale non butta il filo. Timeout di sicurezza a NEW_CHAT_CONFIRM_MS.
  const [confirmingNewChat, setConfirmingNewChat] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Slot in cui Chat pubblica la sua funzione di reset (vive in un altro nodo
  // del DOM: il bottone è nell'header, il reset dentro Chat).
  const resetRef = useRef<(() => void) | null>(null);
  const strings = getStrings(config.language);

  /** Annulla il timer di conferma pendente (se presente). */
  function clearConfirmTimer() {
    if (confirmTimer.current !== null) {
      clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
  }

  // Pulizia del timer allo smontaggio e alla chiusura del pannello (che smonta
  // Chat): la conferma non deve sopravvivere a una riapertura.
  useEffect(() => {
    if (!open) {
      clearConfirmTimer();
      setConfirmingNewChat(false);
    }
    return clearConfirmTimer;
  }, [open]);

  function onNewChatClick() {
    if (!confirmingNewChat) {
      // Primo click: arma la conferma e programma l'auto-annullamento.
      setConfirmingNewChat(true);
      clearConfirmTimer();
      confirmTimer.current = setTimeout(() => {
        confirmTimer.current = null;
        setConfirmingNewChat(false);
      }, NEW_CHAT_CONFIRM_MS);
      return;
    }
    // Secondo click: conferma → reset della conversazione.
    clearConfirmTimer();
    setConfirmingNewChat(false);
    resetRef.current?.();
  }

  return (
    <div class="sw-root">
      {open ? (
        <div class="sw-panel" role="dialog" aria-label={config.title}>
          <div class="sw-header">
            <div class="sw-header-text">
              <div class="sw-header-title">{config.title}</div>
              <div class="sw-header-note">{strings.assistantNote}</div>
            </div>
            <button
              class={
                confirmingNewChat ? "sw-header-newchat sw-header-newchat--confirm" : "sw-header-newchat"
              }
              aria-label={confirmingNewChat ? strings.newChatConfirm : strings.newChat}
              title={confirmingNewChat ? strings.newChatConfirm : strings.newChat}
              onClick={onNewChatClick}
            >
              {confirmingNewChat ? "?" : "⟳"}
            </button>
            <button
              class="sw-header-close"
              aria-label={strings.closeLabel}
              onClick={() => setOpen(false)}
            >
              ✕
            </button>
          </div>
          <Chat
            base={base}
            user={user}
            strings={strings}
            welcomeMessage={config.welcomeMessage || strings.welcomeFallback}
            chatEnabled={config.chatEnabled}
            initialConversationId={getConversationId(base.slug)}
            resetRef={resetRef}
          />
        </div>
      ) : null}
      <button
        class={open ? "sw-bubble sw-bubble--hidden" : "sw-bubble"}
        aria-label={open ? strings.closeLabel : strings.openLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "✕" : "💬"}
      </button>
    </div>
  );
}

/**
 * Crea l'host `<div>` su `document.body`, ci attacca uno shadow root aperto con
 * lo `<style>` del widget e renderizza {@link WidgetRoot} dentro. Ritorna l'host
 * (per test/teardown). Isolato in questa funzione così l'entry può gestire la
 * guardia di doppia init.
 */
export function mountWidget(base: WidgetApiBase, config: ActiveConfig, user: WidgetUser): HTMLElement {
  const host = document.createElement("div");
  host.setAttribute("data-stubwise-widget", "");
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = widgetStyles(config.accentColor);
  shadow.appendChild(style);

  const mountPoint = document.createElement("div");
  shadow.appendChild(mountPoint);

  render(<WidgetRoot base={base} config={config} user={user} />, mountPoint);
  return host;
}
