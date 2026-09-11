import { MailWorkspace } from "../components/mail-workspace";

/**
 * `/mail` (fase 9, Task 5): la posta a tre colonne — vedi `MailWorkspace`.
 * Nessuna riga selezionata: il pannello di lettura a destra mostra l'invito
 * a scegliere un messaggio, non un vuoto.
 */
export function MailPage() {
  return <MailWorkspace selected={null} />;
}
