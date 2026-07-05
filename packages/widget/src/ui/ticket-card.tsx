/**
 * Card di conferma ticket in coda alla chat. Nasce da un evento
 * `ticket_proposal` dello stream: mostra il tipo (badge), un titolo e un corpo
 * PRECOMPILATI dalla proposta ma editabili, e i bottoni invia/annulla.
 *
 * Stati locali:
 *  - "form": campi editabili + azioni;
 *  - "sending": invio in corso (bottoni disabilitati);
 *  - "confirmed": conferma "✓ <sent> #<number>", card immutabile;
 *  - errore d'invio: messaggio + bottone "riprova" (torna a "form").
 *
 * La card è autonoma: riceve la proposta e i callback `onConfirm`/`onCancel`.
 * `onConfirm` fa la chiamata di rete (nel parent) e RIGETTA in caso d'errore,
 * così la card mostra il retry senza conoscere l'API.
 */
import { useState } from "preact/hooks";
import type { WidgetTicketProposal } from "../core/sse.js";
import type { WidgetStrings } from "../i18n.js";

/** Etichetta i18n del badge per il tipo di ticket. */
function badgeLabel(type: WidgetTicketProposal["type"], t: WidgetStrings): string {
  if (type === "bug") return t.ticketBug;
  if (type === "feedback") return t.ticketFeedback;
  return t.ticketFeature;
}

export interface TicketCardProps {
  proposal: WidgetTicketProposal;
  strings: WidgetStrings;
  /** Invia la segnalazione (title/body editati). Rigetta su errore → retry. */
  onConfirm: (input: { title: string; body: string }) => Promise<{ number: number }>;
  /** Annulla la card (rimossa dal parent). */
  onCancel: () => void;
}

export function TicketCard({ proposal, strings, onConfirm, onCancel }: TicketCardProps) {
  const [title, setTitle] = useState(proposal.title);
  const [body, setBody] = useState(proposal.body);
  const [status, setStatus] = useState<"form" | "sending" | "confirmed">("form");
  const [number, setNumber] = useState<number | null>(null);
  const [error, setError] = useState(false);

  if (status === "confirmed") {
    return (
      <div class="sw-card">
        <div class="sw-card-confirmed">
          ✓ {strings.ticketSent}
          {number !== null ? ` #${number}` : ""}
        </div>
      </div>
    );
  }

  const sending = status === "sending";

  async function submit() {
    setStatus("sending");
    setError(false);
    try {
      const { number: n } = await onConfirm({ title, body });
      setNumber(n);
      setStatus("confirmed");
    } catch {
      setError(true);
      setStatus("form");
    }
  }

  return (
    <div class="sw-card">
      <span class="sw-badge">{badgeLabel(proposal.type, strings)}</span>
      <input
        class="sw-input"
        value={title}
        placeholder={strings.ticketTitlePlaceholder}
        disabled={sending}
        onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
      />
      <textarea
        class="sw-textarea"
        value={body}
        placeholder={strings.ticketBodyPlaceholder}
        disabled={sending}
        onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
      />
      {error ? <div class="sw-card-msg">{strings.ticketError}</div> : null}
      <div class="sw-card-actions">
        <button class="sw-btn" disabled={sending} onClick={submit}>
          {error ? strings.ticketRetry : strings.ticketSubmit}
        </button>
        <button class="sw-btn sw-btn-secondary" disabled={sending} onClick={onCancel}>
          {strings.ticketCancel}
        </button>
      </div>
    </div>
  );
}
