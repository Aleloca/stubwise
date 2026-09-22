import type { TicketStatus } from "@stubwise/shared";

/**
 * GLI STATI «APERTI» di un ticket: tutto ciò che non è chiuso.
 *
 * Sono gli stessi quattro di `DEFAULT_ACTIVE_STATUSES` sul web
 * (`apps/web/src/routes/tickets/index.tsx`) — «aperto» per un ticket vuol
 * dire *non chiuso*, e un ticket in lavorazione è aperto quanto uno appena
 * arrivato.
 *
 * ⚠️ È lo stesso insieme che CONTA la sezione dell'hub e che la schermata
 * mostra al primo ingresso, e deve restare uno solo: se il conteggio in cima
 * («TICKET · 14 aperti») e l'elenco che si apre toccando «vedi» partissero da
 * due definizioni diverse, il numero mentirebbe esattamente nel momento in
 * cui lo si verifica.
 */
export const OPEN_TICKET_STATUSES: TicketStatus[] = ["open", "triaged", "in_progress", "in_review"];

/**
 * GLI STATI «IN CORSO»: un sottoinsieme degli aperti, non un'alternativa —
 * il lavoro che l'agente o una persona hanno già cominciato.
 */
export const IN_PROGRESS_TICKET_STATUSES: TicketStatus[] = ["in_progress", "in_review"];
