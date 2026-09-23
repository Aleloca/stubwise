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

/**
 * Chiavi di query dei PROGETTI (22 set 2026, hub di progetto, tappa 2).
 *
 * Stessa regola di {@link ticketKeys}: il prefisso è il punto. Qui nessuna
 * mutazione dell'app tocca un progetto o i suoi repository — si configurano
 * da un computer — quindi oggi non c'è niente da ereditare; la chiave sta
 * sotto `["projects"]` perché il giorno in cui qualcosa li cambierà non
 * debba anche ricordarsi di questa vista.
 *
 * ⚠️ Non copre `["projects","list"]` né `["projects","pulse"]`, che sono
 * letterali più vecchi sparsi in tre schermate: migrarli è churn senza
 * guadagno di comportamento, e non è il lavoro di questa tappa.
 */
export const projectKeys = {
  all: ["projects"] as const,
  /** Il progetto con il suo elenco sintetico di repository (`projects.get`). */
  detail: (projectId: string) => [...projectKeys.all, "detail", projectId] as const,
};

/**
 * Chiavi di query delle MILESTONE (22 set 2026, hub di progetto, tappa 2).
 *
 * ⚠️ Un prefisso PROPRIO e non `["projects", id, "milestones"]` (com'era
 * scritto a mano in `WorkScreen`), per una ragione misurata: i CONTEGGI di
 * una milestone cambiano quando un ticket entra o esce da lei, e quello
 * succede da `usePatchTicket` — una mutazione che sta su un'altra schermata e
 * che non deve conoscere né la roadmap né l'hub. Con un prefisso suo le basta
 * dichiarare «ho cambiato una milestone»; annidate sotto i progetti servirebbe
 * invalidare `["projects"]` per intero, cioè anche il polso e la lista, per
 * aggiornare due numeri.
 */
export const milestoneKeys = {
  all: ["milestones"] as const,
  forProject: (projectId: string) => [...milestoneKeys.all, "project", projectId] as const,
};

/**
 * Chiavi di query dei REPOSITORY (22 set 2026, hub di progetto, tappa 2).
 *
 * Indicizzate per SLUG e non per id: è così che la rotta li indirizza, ed è
 * quello che l'app ha in mano venendo dall'elenco. Stessa regola del
 * prefisso di {@link ticketKeys} — nell'app niente modifica un repository, ma
 * il giorno in cui qualcosa lo farà non dovrà anche ricordarsi di questa
 * schermata.
 */
export const repositoryKeys = {
  all: ["repositories"] as const,
  detail: (slug: string) => [...repositoryKeys.all, "detail", slug] as const,
};
