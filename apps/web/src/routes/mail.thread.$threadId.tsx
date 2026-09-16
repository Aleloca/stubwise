import { useParams, useSearch } from "@tanstack/react-router";
import { MailWorkspace } from "../components/mail-workspace";

/**
 * `/mail/thread/:threadId` — una CONVERSAZIONE aperta direttamente dall'URL
 * (15 set 2026, design §3).
 *
 * Nasce per la ricerca: un risultato di posta porta alla conversazione, non
 * al singolo messaggio, e prima di questa rotta le conversazioni non avevano
 * un indirizzo — si aprivano solo cliccando una riga della lista, in stato
 * locale. Effetto collaterale utile: ora un thread è condivisibile, come lo
 * era già il singolo messaggio (`/mail/:source/:id`, che resta dov'è per le
 * card d'inbox).
 *
 * `?message=` dice QUALE messaggio ha combaciato: chi arriva dalla ricerca
 * lo trova segnato, invece di dover rileggere lo scambio per capire perché è
 * comparso.
 */
export function MailThreadPage() {
  const { message } = useSearch({ from: "/authed/mail/thread/$threadId" });
  const { threadId } = useParams({ from: "/authed/mail/thread/$threadId" });
  return (
    // ⚠️ `key` sul threadId: `MailWorkspace` semina il suo stato locale
    // (`openThread`) da questa prop, e un componente con stato locale seminato
    // da una prop di IDENTITÀ va keyato su quell'identità — altrimenti,
    // passando da una conversazione all'altra senza smontare, resterebbe
    // aperta la precedente. È la stessa lezione di `SeriesConfig` e di
    // `MailReadingPane`.
    <MailWorkspace
      key={threadId}
      selected={null}
      openThreadId={threadId}
      highlightMessageId={message ?? null}
    />
  );
}
