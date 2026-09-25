import type { MailDetailSource, MailFilters } from "@stubwise/api-client";
import type { BacklogChip } from "./backlog-mutations";

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

/**
 * Chiavi di query dei SERVER di monitoraggio (23 set 2026, hub di progetto,
 * tappa 3).
 *
 * Stessa regola del prefisso di {@link ticketKeys}: nell'app niente modifica
 * un server — si configurano da un computer — ma il giorno in cui qualcosa lo
 * farà, un `invalidateQueries({ queryKey: serverKeys.all })` raggiungerà
 * elenco, dettaglio e sezione dell'hub senza doversi ricordare di loro.
 *
 * La sezione dell'hub e la schermata dietro «vedi ›» usano la STESSA chiave
 * (`forProject`): chiedono la stessa risposta, senza `limit`, quindi non c'è
 * motivo di tenerle distinte come per ticket e backlog.
 */
export const serverKeys = {
  all: ["servers"] as const,
  forProject: (projectId: string) => [...serverKeys.all, "list", "project", projectId] as const,
  detail: (serverId: string) => [...serverKeys.all, "detail", serverId] as const,
};

/**
 * IL POLSO dei progetti (`GET /api/projects/pulse`), letto da
 * `ProjectsScreen` e `ProjectDetailScreen`.
 *
 * Qui dal 23 set 2026 (l'app non resta indietro), prima dentro
 * `ProjectsScreen.tsx`: le mutazioni condivise lo invalidano, e una libreria
 * che importa da una schermata è la dipendenza nel verso sbagliato. Stesso
 * valore di sempre, sotto `["projects"]` — `projectKeys.all` lo raggiunge
 * ancora.
 *
 * ⚠️ Le mutazioni invalidano QUESTA chiave, non `projectKeys.all`: quella
 * porterebbe con sé dettaglio, lista e impostazioni di ogni progetto a ogni
 * «Fatto» su una notifica. Si dichiara il minimo che è cambiato davvero.
 */
export const projectsPulseKey = ["projects", "pulse"] as const;

/**
 * Chiavi del BACKLOG — qui dal 23 set 2026, prima in `backlog-mutations.ts`
 * (che le ri-esporta): `useDecision` deve invalidarle e non può importare
 * quel file senza un ciclo.
 */
export const backlogKeys = {
  all: ["backlog"] as const,
  list: (chip: BacklogChip, projectId?: string) => [...backlogKeys.all, "list", chip, projectId ?? null] as const,
  item: (id: string) => [...backlogKeys.all, "item", id] as const,
};

/** Chiavi della POSTA — qui dal 23 set 2026, stessa ragione di {@link backlogKeys}. */
export const mailKeys = {
  all: ["mail"] as const,
  list: (filters: MailFilters) => [...mailKeys.all, "list", filters] as const,
  detail: (source: MailDetailSource, id: string) => [...mailKeys.all, "detail", source, id] as const,
  /** La lista per CONVERSAZIONE, distinta da quella per messaggio. */
  threads: () => [...mailKeys.all, "threads"] as const,
  thread: (threadId: string) => [...mailKeys.all, "thread", threadId] as const,
  /**
   * Le mail tenute fuori dal cancello (25 set 2026). Sotto `all` apposta: il
   * pull-to-refresh della Posta e ogni invalidazione della posta la prendono
   * senza saperne niente.
   */
  rejections: (days: number) => [...mailKeys.all, "rejections", days] as const,
};

/**
 * Chiavi di query del lavoro di UN ticket: dettaglio ticket (`implementationPlan`
 * incluso), job (la timeline) e domande dell'agente. Raggruppate sotto lo
 * stesso genitore (`all(ticketId)`) così un'unica `invalidateQueries` dopo
 * approva/rifiuta rinfresca tutt'e tre — la schermata Lavoro (Task 16) le
 * legge tutte per costruire la timeline in parole (`lib/timeline.ts`).
 */
export const workKeys = {
  /**
   * IL TICKET APERTO, qualunque sia (23 set 2026). Una decisione dall'inbox
   * agisce su una NOTIFICA e non sa quale ticket sia aperto sullo schermo:
   * invalidare il prefisso segna scaduto l'albero di ogni ticket, e si
   * ricarica solo quello montato.
   */
  root: ["work"] as const,
  all: (ticketId: string) => [...workKeys.root, ticketId] as const,
  ticket: (ticketId: string) => [...workKeys.all(ticketId), "ticket"] as const,
  jobs: (ticketId: string) => [...workKeys.all(ticketId), "jobs"] as const,
  questions: (ticketId: string) => [...workKeys.all(ticketId), "questions"] as const,
  /** Il feed di attività del ticket (fase 5): date reali dei passi della timeline. */
  activity: (ticketId: string) => [...workKeys.all(ticketId), "activity"] as const,
  /** I commenti del ticket: la conversazione attorno al lavoro. */
  comments: (ticketId: string) => [...workKeys.all(ticketId), "comments"] as const,
};

