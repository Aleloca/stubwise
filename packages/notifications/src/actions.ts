/**
 * CATALOGO DELLE AZIONI di una notifica: cosa si può fare su una riga d'inbox,
 * in funzione del `kind`, dello stato attuale del job e dei permessi di chi
 * guarda nel progetto della notifica.
 *
 * Modulo PURO: nessun accesso al DB, nessuna dipendenza da Fastify. ⚠️ E la
 * purezza è VERIFICATA, non promessa: questo file sta nel grafo dell'entry
 * client `./pure.ts`, e `pure.test.ts` diventa rosso se ci arriva (anche in
 * transitivo) `@stubwise/db`, `drizzle-orm` o un builtin di Node. Vive qui —
 * e non nel servizio inbox del server — perché ha DUE consumatori:
 *  - `apps/server/src/services/inbox.ts` (lista e esecuzione delle azioni), che
 *    lo ri-esporta per i suoi chiamanti;
 *  - il poller delle consegne del worker, che compone i bottoni Block Kit del
 *    DM Slack con le azioni calcolate PER IL DESTINATARIO (il worker non può
 *    importare da `apps/server`).
 *
 * Il catalogo è CALCOLATO, mai persistito: dipende dallo stato ATTUALE del job,
 * e persisterlo vorrebbe dire riscriverlo a ogni transizione (e sbagliarlo).
 */
import type { ProjectPermission } from "@stubwise/shared";
import type { NotificationEvent, NotificationKind } from "./format.js";

/** Le azioni che una notifica può offrire. `open` è l'unica non eseguibile lato server. */
export type ActionId =
  | "approve_plan"
  | "reject_plan"
  | "relaunch"
  | "answer"
  | "open"
  | "snooze"
  | "handled"
  /**
   * Fase permessi (ruling R36): «Passa al progetto» sulla card `google.proposal`
   * del proprietario. NON sta nel catalogo per kind: dipende dai permessi
   * ATTUALI del proprietario per le azioni di QUELLA proposta, che un modulo
   * puro non conosce. La deriva il server a lettura (`listInbox`) e la
   * ricontrolla all'esecuzione (`handGoogleProposal`), con la stessa regola.
   */
  | "hand_to_project";

/** Durate di rinvio ammesse dallo snooze. */
export type SnoozeUntil = "1h" | "tomorrow" | "3d";

/** Le durate di snooze nell'ordine in cui vanno offerte (menù Slack e UI). */
export const SNOOZE_OPTIONS: readonly SnoozeUntil[] = ["1h", "tomorrow", "3d"];

/**
 * Chi compie l'azione: l'identità e i SUOI permessi nel progetto della
 * notifica, calcolati dal server (o dal worker) — mai dedotti dal ruolo.
 * `null` = non vede quel progetto (non membro e non full admin): nessuna
 * decisione gli è concessa, neanche quella d'identità del richiedente.
 */
export interface ActionActor {
  id: string;
  permissions: ReadonlySet<ProjectPermission> | null;
}

/**
 * Il permesso con cui, oltre al richiedente, si risponde alla domanda
 * dell'agente: chi può decidere del piano (prima: «un maintainer»). È lo
 * stesso permesso che fa ricevere la domanda (`PERMISSION_FOR_KIND` in
 * `./routing.ts`).
 */
export const ANSWER_FOR_OTHERS_PERMISSION: ProjectPermission = "plans.approve";

/**
 * Stati di un job AI considerati "in volo" (lavoro in corso o in attesa di una
 * decisione già richiesta). Definiti qui perché sono un ingrediente del
 * catalogo delle azioni; `apps/server/src/services/jobs.ts` li RI-ESPORTA come
 * `IN_FLIGHT` invece di ridichiararli, così le due liste non possono divergere.
 */
export const IN_FLIGHT_JOB_STATUSES = [
  "queued",
  "triaging",
  "fixing",
  "awaiting_plan_approval",
  // Parcheggiato su una domanda dell'agente: il lavoro non è finito, aspetta
  // una risposta. Rilanciarlo (o lanciarne un secondo) butterebbe via la
  // sessione CLI che la risposta deve riprendere.
  "awaiting_input",
] as const;

/**
 * Quel poco che serve a {@link actionsFor}: il resto della riga è irrilevante.
 *
 * `requestedByUserId` è il richiedente del job a cui la notifica è ancorata
 * (`null` per i run dell'automazione, o per le notifiche senza job). Serve alle
 * azioni il cui permesso è di IDENTITÀ e non solo di permesso — oggi solo
 * `answer`: a una domanda dell'agente risponde chi ha avviato il run (se vede
 * ancora il progetto), o chi ha {@link ANSWER_FOR_OTHERS_PERMISSION}. È un
 * campo OBBLIGATORIO, non opzionale, perché un chiamante che se lo dimentica
 * toglierebbe in silenzio al richiedente la possibilità di rispondere: meglio
 * che non compili.
 */
export interface ActionableNotification {
  kind: NotificationKind;
  requestedByUserId: string | null;
}

/**
 * IL CATALOGO, per kind: la decisione che offre, il PERMESSO di progetto che
 * serve per prenderla e se la riga si può archiviare a mano.
 *
 * `permission` è quello della rotta che fa la stessa cosa fuori dall'inbox
 * (dopo la fase permessi): approvare o rifiutare un piano → `plans.approve`;
 * rilanciare → `runs.start` (`POST /tickets/:id/run-ai`); far partire una
 * proposta del pulse — converte una voce e avvia un run → `runs.start`.
 * `job.budget_held` resta più stretto: sbloccare un fermo per budget è una
 * decisione di SPESA, e il permesso che scavalca il budget è `plans.approve`
 * (lo stesso di `canResumeCorrection`, ruling R16). `null` = nessun permesso
 * oltre a ricevere la card (o una regola d'identità, vedi `answer`).
 *
 * `job.held` e `job.budget_held` sono lo stesso stato del job (`held`) con
 * `heldReason` diverso: la portano già separata i due `kind`, quindi qui non
 * serve rileggere `ai_jobs.held_reason`.
 *
 * `archivable` sta QUI, e non in un elenco a parte dei kind "senza handled",
 * per una ragione precisa: questo Record è esaustivo su `NotificationKind`, e un
 * kind nuovo non compila finché non gli si risponde a TUTTE le domande del
 * catalogo — decisione, permesso e archiviabilità. Un elenco separato (o un Set
 * di eccezioni) avrebbe invece un default silenzioso: chi aggiunge il kind
 * seguente non si accorgerebbe di doverci passare.
 */
const CATALOG_FOR_KIND: Record<
  NotificationKind,
  { decisions: ActionId[]; permission: ProjectPermission | null; archivable: boolean }
> = {
  "job.plan_review": {
    decisions: ["approve_plan", "reject_plan"],
    permission: "plans.approve",
    archivable: true,
  },
  "job.held": { decisions: ["relaunch"], permission: "runs.start", archivable: true },
  "job.budget_held": { decisions: ["relaunch"], permission: "plans.approve", archivable: true },
  "job.failed": { decisions: ["relaunch"], permission: "runs.start", archivable: true },
  "job.pr_closed": { decisions: ["relaunch"], permission: "runs.start", archivable: true },
  // Informativi: si aprono, si rinviano, si archiviano. Nient'altro.
  "job.pr_opened": { decisions: [], permission: null, archivable: true },
  "review.completed": { decisions: [], permission: null, archivable: true },
  "ticket.created": { decisions: [], permission: null, archivable: true },
  "docs.limit_paused": { decisions: [], permission: null, archivable: true },
  "docs.nightly_attention": { decisions: [], permission: null, archivable: true },
  // `permission` NON è «chi lo riceve» (quello è il routing, `deciders`): vuol
  // dire «la DECISIONE richiede questo permesso», e qui non c'è decisione. Con
  // `plans.approve` web e app lo metterebbero in «in attesa di un maintainer»
  // e nasconderebbero «Apri» proprio a chi lo riceve.
  "request.created": { decisions: [], permission: null, archivable: true },
  "monitor.alert": { decisions: [], permission: null, archivable: true },
  "monitor.recovered": { decisions: [], permission: null, archivable: true },
  // NON archiviabile di proposito: la domanda dell'agente si chiude solo
  // rispondendo. Archiviarla lascerebbe il job parcheggiato in `awaiting_input`
  // in silenzio, senza che nessuno si accorga che aspetta ancora qualcuno.
  //
  // ⚠️ Regge su un fatto NON LOCALE: l'unica uscita da `awaiting_input` è la
  // risposta, che chiude le copie della notifica in propagazione. Chi
  // introducesse un'altra uscita da quello stato (un annullamento, una
  // scadenza, un recovery) DEVE chiudere anche le notifiche: qui non resterebbe
  // nessuna azione utile — `answer` la nega lo stato, `handled` la nega il
  // catalogo — e la riga vivrebbe per sempre a colpi di snooze.
  //
  // La stessa trappola si apre anche SENZA una nuova uscita, per un guasto:
  // fra la scrittura della risposta e la sua propagazione c'è una finestra (il
  // processo muore, la propagazione fallisce) che lascia le copie `open` su un
  // job ormai ripartito. Per questo `answerQuestion`
  // (`apps/server/src/services/questions.ts`) le SANA quando le incontra: un
  // tentativo di rispondere su una card ormai vecchia chiude le copie
  // attribuendole a chi aveva risposto davvero.
  //
  // ⚠️ Quella riparazione è PIGRA, e SUL WEB non è raggiungibile. Appena il job
  // esce da `awaiting_input`, `actionsFor` non offre più né `answer` (lo nega
  // `stateAllows`) né `handled` (lo nega `archivable: false`): sulla card
  // orfana restano apri e rinvia, nessun gesto che arrivi ad `answerQuestion`.
  // Ci arrivano solo i bottoni di un DM Slack stale — pubblicato prima del
  // guasto e mai riscritto, quindi ancora premibile. Conseguenza nel caso raro:
  // senza quel DM (Slack spento, account non collegato) o senza nessuno che lo
  // prema, la copia orfana resta sul web per sempre, smaltibile solo a colpi di
  // snooze. È il prezzo accettato per non dare alla domanda un'archiviazione
  // che ne farebbe perdere di vista una VIVA.
  "job.awaiting_input": { decisions: ["answer"], permission: null, archivable: false },
  // Il pulse offre la stessa decisione della domanda — si sceglie una delle
  // proposte — ma è ARCHIVIABILE, al contrario di quella: dietro non c'è nessun
  // job fermo ad aspettare, e non dare seguito a un suggerimento è una risposta
  // legittima. Senza `handled` la card resterebbe in inbox per sempre a chi non
  // vuole partire da nessuna delle proposte.
  //
  // Chi può rispondere e con quale stato lo dicono `actorAllows`/`stateAllows`,
  // che su `answer` ragionano PER KIND (vedi {@link KINDS_WITH_OPTIONS}): al
  // pulse risponde il destinatario che può avviare un run (`runs.start`: la
  // proposta scelta diventa un ticket e un run), e non c'è nessuno stato di
  // job da leggere.
  "project.pulse": { decisions: ["answer"], permission: "runs.start", archivable: true },
  // Il brief settimanale si LEGGE: non chiede niente a nessuno, quindi nessuna
  // decisione. Archiviabile come ogni informativa — letta la settimana, la card
  // esce dall'inbox.
  "project.brief": { decisions: [], permission: null, archivable: true },
  // La proposta dalla posta offre la stessa decisione del pulse — si conferma
  // un'opzione — ed è ARCHIVIABILE: non dare seguito a una email è una
  // risposta legittima, e dietro non c'è nessun job fermo ad aspettare.
  // `permission: null` è coerente con l'audience `mailbox_owner`: il
  // destinatario è uno solo, e il ruolo non c'entra.
  "google.proposal": { decisions: ["answer"], permission: null, archivable: true },
  // La proposta PASSATA al progetto (fase permessi): la ricevono solo i
  // decisori del progetto (`project_deciders`), e quale opzione ognuno può
  // confermare dipende dall'AZIONE dietro l'opzione — `permission: null` qui
  // vuol dire «nessun permesso unico per la card»; il controllo per azione lo
  // fa il servizio (`answerGoogleProposal`), come sulla card del proprietario.
  // Archiviabile: archiviare chiude la sola copia di chi archivia, la
  // proposta resta decidibile dagli altri.
  "google.proposal_handed": { decisions: ["answer"], permission: null, archivable: true },
  // L'avviso di sicurezza si legge e si archivia: nessuna decisione.
  "security.alert": { decisions: [], permission: null, archivable: true },
};

/**
 * Il kind ha almeno una decisione riservata a un MAINTAINER — cioè a chi ha
 * `plans.approve` (piano da approvare, fermo per budget)? App M1 (11 set
 * 2026): esportata perché l'app mobile duplicava questa stessa informazione a
 * mano — un `Set` di due nomi di kind copiati in
 * `apps/mobile/src/lib/inbox-sections.ts`, per la sezione "In attesa di
 * altri" dell'inbox — invece di leggerla da QUI. Non `actionsFor` per intero:
 * quella funzione vuole un attore e lo stato di un job, che una domanda di
 * sola sezionatura non ha e non le serve. Le decisioni a `runs.start`
 * (rilanci, pulse) non contano: sono di chiunque lavori sul progetto.
 */
export function isAdminOnlyKind(kind: NotificationKind): boolean {
  return CATALOG_FOR_KIND[kind].permission === "plans.approve";
}

/**
 * I kind la cui notifica porta nel payload una DOMANDA A OPZIONI, e che per
 * questo offrono `answer`.
 *
 * È il Set che le superfici interrogano per sapere se disegnare i bottoni delle
 * scelte al posto del testo: il recinto per-item dell'inbox
 * (`apps/server/src/services/inbox.ts`, che estrae la domanda dal payload) e il
 * poller delle consegne del worker (che compone i blocchi Slack). Prima c'era
 * un confronto con `job.awaiting_input` ripetuto in entrambi i posti; ora la
 * lista è una sola.
 *
 * Sta accanto al catalogo perché è la sua faccia complementare: il catalogo
 * dice CHE COSA si può fare, questo Set dice quali payload sanno *offrire* le
 * scelte. I due non possono divergere — un kind qui dentro che non dichiarasse
 * `answer` mostrerebbe bottoni che danno sempre errore — e un test lo verifica.
 */
export const KINDS_WITH_OPTIONS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  "job.awaiting_input",
  "project.pulse",
  "google.proposal",
  "google.proposal_handed",
]);

/**
 * I kind con opzioni che NON hanno un job dietro.
 *
 * È la faccia "stato" di {@link KINDS_WITH_OPTIONS}, e serve a due predicati
 * diversi che senza di lei ripeterebbero lo stesso elenco:
 *
 *  - {@link stateAllows} — non c'è nessun `ai_jobs.status` da leggere
 *    (`jobStatus` è per forza `null`), quindi la regola "il job dev'essere in
 *    `awaiting_input`" li escluderebbe SEMPRE. Ciò che deve essere ancora
 *    aperto è la RIGA di notifica, e la verifica chi esegue l'azione;
 *  - {@link actorAllows} — non essendoci un job non c'è nemmeno un
 *    "richiedente" a cui la domanda sia rivolta: risponde chi la riceve, col
 *    permesso del catalogo. Sul pulse è chi può avviare un run; su
 *    `google.proposal` è UNA persona sola — l'audience `mailbox_owner` la
 *    consegna solo al proprietario della casella — e il controllo che conta
 *    ("questa riga è tua") è il `WHERE` sull'utente in `executeAction`, non un
 *    permesso. Chiederne uno qui toglierebbe la proposta proprio all'unica
 *    persona a cui è rivolta.
 *
 * Scritta al POSITIVO sui soli kind esenti: un kind con opzioni aggiunto
 * domani ricade sul controllo severo invece di ereditare un lasciapassare.
 */
const KINDS_WITHOUT_JOB: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  "project.pulse",
  "google.proposal",
  "google.proposal_handed",
]);

/** Igiene dell'inbox: presente su OGNI notifica, non è una decisione. */
const HYGIENE: readonly ActionId[] = ["open", "snooze"];

/**
 * Azioni NON decisionali offerte dal kind: l'igiene, più l'archiviazione dove il
 * catalogo la ammette. Sono in coda alle decisioni in {@link actionsFor}.
 */
function hygieneFor(kind: NotificationKind): ActionId[] {
  return CATALOG_FOR_KIND[kind].archivable ? [...HYGIENE, "handled"] : [...HYGIENE];
}

/** True se lo stato del job è uno di {@link IN_FLIGHT_JOB_STATUSES} (lavoro in corso). */
function isInFlight(jobStatus: string | null | undefined): boolean {
  return jobStatus != null && (IN_FLIGHT_JOB_STATUSES as readonly string[]).includes(jobStatus);
}

/**
 * Il KIND prevede questa azione? È una domanda sul CATALOGO, indipendente da chi
 * chiede: `approve_plan` su un `job.failed` non è "vietato", è una richiesta che
 * non ha senso — e va distinta perché il chiamante risponde `invalid_action`
 * (400) invece di `forbidden` (403), che suggerirebbe a torto "riprova da admin".
 */
export function kindOffers(kind: NotificationKind, action: ActionId): boolean {
  return hygieneFor(kind).includes(action) || CATALOG_FOR_KIND[kind].decisions.includes(action);
}

/**
 * QUESTO actor può compiere l'azione? Separata da {@link kindOffers} e da
 * {@link stateAllows} perché i tre "no" hanno messaggi diversi: azione fuori
 * catalogo → `invalid_action`, permesso insufficiente → `forbidden`, stato del
 * job incompatibile → `plan_not_pending`/`job_in_flight`.
 *
 * Le decisioni chiedono il `permission` del catalogo nel progetto della
 * notifica. `answer` sulla domanda dell'agente no: la domanda è rivolta a chi
 * ha chiesto il run (il più delle volte l'unico che sa rispondere nel merito,
 * finché vede il progetto), e in più a chi ha
 * {@link ANSWER_FOR_OTHERS_PERMISSION} — che deve poter sbloccare un job
 * parcheggiato da un collega in ferie. Per questo prende la notifica intera e
 * l'actor intero, identità compresa.
 *
 * Su `answer` la regola dipende dal KIND, e questa resta la sua sede unica: chi
 * arriva alla risposta senza passare dal catalogo (la pagina ticket, i bottoni
 * Slack) la ri-applica chiamando qui, non riscrivendola.
 */
export function actorAllows(
  notification: ActionableNotification,
  action: ActionId,
  actor: ActionActor,
): boolean {
  const { kind, requestedByUserId } = notification;
  if (!kindOffers(kind, action)) return false;
  if (hygieneFor(kind).includes(action)) return true;
  if (action === "answer" && !KINDS_WITHOUT_JOB.has(kind)) {
    // La domanda dell'agente: il richiedente se vede ancora il progetto,
    // oppure chi ha il permesso di sbloccarla per lui.
    if (actor.permissions === null) return false;
    return (
      actor.permissions.has(ANSWER_FOR_OTHERS_PERMISSION) ||
      (requestedByUserId !== null && actor.id === requestedByUserId)
    );
  }
  // I kind SENZA JOB (pulse e proposta dalla posta) non hanno un richiedente:
  // la prende in mano chi l'ha ricevuta, col permesso del catalogo (nessuno per
  // la proposta). Vedi {@link KINDS_WITHOUT_JOB} per il perché, kind per kind.
  const required = CATALOG_FOR_KIND[kind].permission;
  return required === null || (actor.permissions?.has(required) ?? false);
}

/**
 * Lo STATO ATTUALE del job consente l'azione? `approve_plan`/`reject_plan` solo
 * su un piano davvero fermo sul gate; `answer` solo su un job davvero fermo su
 * una domanda (ripartito, la risposta non ha più nessuno che l'aspetta);
 * `relaunch` solo se l'ultimo job del ticket non è in volo (rilanciarne uno vivo
 * scippa il lavoro al worker).
 *
 * Prende il `kind` come primo argomento — stessa forma di {@link kindOffers}, e
 * stesso ordine "soggetto, azione, contesto" di {@link actorAllows} — perché su
 * `answer` la risposta dipende da lui: il pulse un job dietro non ce l'ha, e la
 * regola "il job deve essere in `awaiting_input`" su di lui non significherebbe
 * nulla (`jobStatus` sarebbe sempre `null`, e l'azione non verrebbe mai
 * offerta).
 */
export function stateAllows(
  kind: NotificationKind,
  action: ActionId,
  jobStatus: string | null | undefined,
): boolean {
  switch (action) {
    case "approve_plan":
    case "reject_plan":
      return jobStatus === "awaiting_plan_approval";
    case "answer":
      // I kind senza job non hanno uno stato da leggere: ciò che deve essere
      // ancora "aperto" è la RIGA di notifica, e quella la verifica chi esegue
      // l'azione (`executeAction`, che la sta già leggendo). Vedi
      // {@link KINDS_WITHOUT_JOB}, che è anche il motivo per cui la condizione
      // è scritta al positivo sui soli kind esenti.
      return KINDS_WITHOUT_JOB.has(kind) || jobStatus === "awaiting_input";
    case "relaunch":
      return !isInFlight(jobStatus);
    default:
      return true;
  }
}

/**
 * Azioni offerte su una notifica, nell'ordine in cui vanno mostrate: prima le
 * decisioni (se chi guarda e lo stato del job le consentono), poi l'igiene
 * dell'inbox — apri/rinvia, più archivia sui kind che l'ammettono.
 *
 * `jobStatus` è lo stato dell'ULTIMO job del ticket a cui la notifica è
 * ancorata (`null` per gli eventi senza ticket, come `monitor.*`). Funzione
 * pura: nessun accesso al DB, così la si può chiamare in batch su una pagina
 * intera senza N+1.
 */
export function actionsFor(
  notification: ActionableNotification,
  jobStatus: string | null | undefined,
  actor: ActionActor,
): ActionId[] {
  const decisions = CATALOG_FOR_KIND[notification.kind].decisions.filter(
    (action) =>
      actorAllows(notification, action, actor) && stateAllows(notification.kind, action, jobStatus),
  );
  return [...decisions, ...hygieneFor(notification.kind)];
}

/**
 * Dove porta `open`: la superficie su cui l'utente va a *fare* qualcosa.
 *
 * Per gli eventi il cui soggetto È la pull request (`job.pr_opened`,
 * `review.completed`) è la PR sul provider git — è lì che si legge il diff e si
 * approva. Per `job.pr_closed` no: la PR è chiusa, quello che conta è il ticket
 * riaperto. Gli eventi senza ticket portano alla loro pagina (Docs, server
 * monitorato).
 */
export function openUrl(event: NotificationEvent): string {
  switch (event.kind) {
    case "job.pr_opened":
    case "review.completed":
      return event.prUrl;
    case "docs.limit_paused":
    case "docs.nightly_attention":
      return event.docsUrl;
    case "request.created":
    case "monitor.alert":
    case "monitor.recovered":
      return event.url;
    // Il pulse è ancorato al progetto, non a un ticket: "Apri" porta dove si
    // vedono TUTTE le proposte, cioè il backlog del progetto.
    case "project.pulse":
    // Il brief porta alla roadmap, dove si legge per intero in mezzo agli
    // eventi del periodo che racconta.
    case "project.brief":
      return event.projectUrl;
    // La proposta porta ALLA FONTE — il thread Gmail o l'evento di calendario
    // — perché è lì che si capisce se ha senso confermarla.
    case "google.proposal":
      return event.messageUrl;
    // La proposta passata porta al progetto: il thread Gmail sta nella casella
    // di chi l'ha passata, e chi la riceve non può aprirlo.
    case "google.proposal_handed":
      return event.projectUrl;
    // Nessuna superficie da aprire (l'avviso si legge in inbox): la stringa
    // vuota è il «nessun link» che inbox, DM e Slack già scartano.
    case "security.alert":
      return "";
    case "ticket.created":
    case "job.pr_closed":
    case "job.held":
    case "job.plan_review":
    case "job.budget_held":
    case "job.failed":
    case "job.awaiting_input":
      return event.ticketUrl;
  }
}
