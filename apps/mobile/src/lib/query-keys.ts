/**
 * Chiavi di query dell'inbox — estratte da `inbox-mutations.ts` in un modulo
 * proprio perché il Task 19 le usa anche in `app/providers.tsx` (refresh al
 * foreground + badge OS), e `providers.tsx` NON può importare
 * `inbox-mutations.ts` direttamente: quel file importa `useAuth` DA
 * `app/providers`, quindi l'import inverso chiuderebbe un ciclo fra i due
 * moduli. Un modulo terzo, senza dipendenze, rompe il ciclo.
 *
 * `inbox-mutations.ts` ri-esporta `inboxKeys` da qui: nessun chiamante
 * esistente (`InboxScreen`, `InboxCardScreen`, `ProjectDetailScreen`, i test)
 * deve cambiare il proprio import.
 *
 * SENZA filtri, a differenza di `inboxKeys` in `apps/web/src/lib/queries.ts`:
 * l'app mobile legge sempre l'inbox APERTA per intero (nessuna vista per
 * progetto/stato in questo task).
 */
export const inboxKeys = {
  all: ["inbox"] as const,
  list: () => [...inboxKeys.all, "list"] as const,
  unread: () => [...inboxKeys.all, "unread"] as const,
};

/**
 * Chiavi di query dei TICKET (22 set 2026, hub di progetto).
 *
 * ⚠️ **Il prefisso `["tickets"]` è il punto di tutta questa struttura**, non
 * un modo di raggruppare: ogni chiave che sta sotto eredita, oggi e in
 * futuro, qualunque `invalidateQueries({ queryKey: ticketKeys.all })`. La
 * strada alternativa — chiavi in un namespace proprio, più un elenco di
 * invalidazioni da tenere aggiornato — obbliga ogni mutazione scritta fra sei
 * mesi a ricordarsi di questa vista, e nessuno se ne ricorderà.
 *
 * Chi sposta queste chiavi «per ordine» sotto un `projects` o un `hub`
 * riapre esattamente il difetto che questo modulo esiste per chiudere: una
 * vista che resta montata sotto, nello stack nativo, e mostra il numero
 * vecchio al ritorno — l'app non ha refetch-on-focus da nessuna parte.
 */
export const ticketKeys = {
  all: ["tickets"] as const,
  /** L'elenco pieno dei ticket di un progetto, per filtro di stato. */
  list: (projectId: string, filter: string) => [...ticketKeys.all, "list", "project", projectId, filter] as const,
  /**
   * L'ANTEPRIMA dell'hub: chiave distinta da {@link ticketKeys.list} perché
   * chiede un `limit` diverso — la stessa chiave farebbe servire una pagina
   * da due righe alla schermata intera. Distinta, ma sotto lo stesso
   * prefisso: è la combinazione che serve.
   */
  hub: (projectId: string) => [...ticketKeys.all, "list", "hub", projectId] as const,
};
