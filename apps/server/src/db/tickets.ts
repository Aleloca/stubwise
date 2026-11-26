/**
 * La creazione di un ticket sta in `@stubwise/db` (area 7: la usa anche
 * l'esecutore delle automazioni nel worker): qui la si ri-esporta, così
 * nessun import del server cambia.
 */
export { createTicket, ProjectNotFoundError, type CreateTicketInput, type Ticket } from "@stubwise/db";
