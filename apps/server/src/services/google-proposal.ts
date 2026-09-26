/**
 * ESECUZIONE DI UNA PROPOSTA GOOGLE (fase 6, Task 11): dalla conferma di
 * un'opzione (`google.proposal`, la card nata da un'email o da un evento di
 * calendario) all'azione vera — voce di backlog, milestone, ticket
 * aggiornato/commentato, decisione registrata, riassegnazione di progetto o
 * «non fare nulla».
 *
 * È il gemello di `./pulse.ts` sul lato posta: stessa disciplina —
 * `actorAllows`, pre-check ottimistico, **claim** (`propagateHandled`) PRIMA
 * di agire, poi l'unico esecutore rimasto dispatcha per tipo — con UNA
 * differenza di rilievo: il pulse chiude sempre in `convertBacklogItem` +
 * `startRun`, qui le sette varianti di `GoogleProposalAction`
 * (`@stubwise/notifications/format.ts`) vanno ciascuna al proprio servizio
 * del Task 3 (`enqueueBacklogIntake`,
 * `createMilestone`, `patchTicket`, `addSystemComment`) o a `recordDecision`
 * (esistente, mai un nuovo scrittore del registro).
 *
 * ⚠️ Fase 6c (Task 5): `GoogleProposalAction` guadagna un uso NUOVO di
 * `choose_project` — la proposta di SMISTAMENTO, che vive sul PADRE
 * (`email_messages`, non su un figlio: non ce n'è nessuno). La stessa azione
 * ha quindi DUE esiti diversi a seconda di dove viene confermata: vedi il
 * commento sopra il case `"choose_project"` in {@link dispatchAction}, che li
 * documenta entrambi fianco a fianco apposta.
 *
 * ⚠️ QUESTO MODULO NON IMPORTA ESECUTORI AI, e non deve MAI farlo: la
 * conferma è di una persona, e il testo che finisce in `project_decisions` è
 * un TEMPLATE i18n (`decision.email.*`) interpolato con `from`/`subject` (non
 * fidati, mai interpretati) e l'ETICHETTA già composta dell'opzione scelta —
 * mai la prosa che il classificatore ha suggerito. Vedi l'invariante nel
 * docblock di `recordDecision` (`@stubwise/db`) e `decisions-never-ai.test.ts`,
 * che elenca anche questo file.
 *
 * ## Chi può eseguire QUESTA proposta
 *
 * L'audience `mailbox_owner` (`@stubwise/notifications/routing.ts`) consegna
 * `google.proposal` a UN SOLO destinatario: il proprietario della casella.
 * `notifications.user_id` su questa riga È quella persona — non un
 * "richiedente" da confrontare come nella domanda dell'agente. Il controllo
 * che conta è perciò il `WHERE` sull'utente nella lettura qui sotto: un
 * `notificationId` valido ma di un altro utente (admin incluso) non trova la
 * riga → `not_found` (404), mai `forbidden` — non se ne rivela l'esistenza.
 * `actorAllows` si richiama comunque (come fa `proceedWithProposal` per il
 * pulse): oggi risponde sempre sì per questo kind
 * (`KINDS_WITHOUT_JOB`), ma se la regola cambiasse un domani questo servizio
 * la seguirebbe invece di restare indietro con una copia sua.
 *
 * ## Lettura TOLLERANTE, ed è voluta
 *
 * `notifications.event` è un jsonb senza CHECK sulla forma, scritto da una
 * versione del codice che può non essere quella che lo rilegge. Un payload
 * che non regge più la validazione (evento intero, o la singola azione
 * all'indice scelto) è trattato come `proposal_stale` — la stessa risposta di
 * una proposta presa da qualcun altro: per chi guarda la card è la stessa
 * notizia, "questa non si può più confermare".
 *
 * ## `target_gone` vs `action_failed`
 *
 * `target_gone` è un esito ATTESO: il servizio del Task 3 ha già un errore
 * tipizzato per "il referente non c'è più" (progetto, ticket) — non è un
 * crash, è la ri-validazione a valle che l'invariante di `GoogleProposalAction`
 * promette («fra la proposta e la conferma passano ore»). `action_failed` è
 * per l'IMPREVISTO — un'eccezione che nessuno dei tre casi tipizzati si
 * aspettava (violazione FK non pre-controllata, errore infrastrutturale).
 * Entrambi, dopo il claim, marcano la riga sorgente `failed`: da lì in poi
 * l'unica differenza fra i due è nel messaggio d'errore, e nessuno dei due
 * lascia la riga sospesa fra "proposta" e "gestita".
 *
 * ⚠️ Nessuna delle sette azioni ha un secondo passo che possa riuscire a metà:
 * ognuna è UNA chiamata a un servizio del Task 3 (o un singolo UPDATE), già
 * atomica per conto suo. `action_failed` qui non porta mai un "pezzo
 * riuscito" perché non esiste un pezzo da riportare — l'intera azione o è
 * scritta (dentro la transazione di {@link dispatchAction}) o non lo è.
 */
import {
  calendarEvents,
  emailMessages,
  emailProposals,
  googleAccounts,
  notifications,
  projects,
  recordDecision,
  tickets,
  users,
  type Db,
} from "@stubwise/db";
import { t, type Language } from "@stubwise/i18n";
import { actorAllows } from "@stubwise/notifications";
import { multiSelectableIndices, ticketPrioritySchema, ticketStatusSchema } from "@stubwise/shared";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getContentLanguage } from "../settings.js";
import { enqueueBacklogIntake } from "./backlog-intake.js";
import { addSystemComment } from "./comments.js";
import type { Actor } from "./jobs.js";
import { createMilestone } from "./milestones.js";
import { mirrorDecision, propagateHandled } from "./notifications-propagation.js";
import { patchTicket } from "./tickets.js";

/** `Db` o una transazione drizzle già aperta (stessa forma dei servizi del Task 3). */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Chi ha già chiuso la riga: l'id per la UI, l'email per dirlo a parole. */
export interface HandledBy {
  id: string;
  email: string;
}

/**
 * Errori tipizzati di {@link answerGoogleProposal}, mappati a HTTP dalle rotte
 * (`routes/inbox.ts`, `sendActionError`). `forbidden` non è mai raggiungibile
 * oggi (vedi il docblock del modulo) ma resta nel contratto per la stessa
 * ragione per cui ci resta in `proceedWithProposal`.
 */
export type AnswerGoogleProposalError =
  | "not_found"
  | "forbidden"
  | "invalid_answer"
  | "already_handled"
  /**
   * L'evento persistito (o l'azione all'indice scelto) non regge più la
   * validazione — un jsonb scritto da una versione precedente — oppure la
   * riga sorgente (`email_messages`/`calendar_events`) non si ritrova più.
   * Per chi guarda la card è la stessa notizia di "già presa da qualcun
   * altro": la proposta non si può più confermare.
   */
  | "proposal_stale"
  /** Il progetto o il ticket dietro l'azione non esiste più. */
  | "target_gone"
  /** Un imprevisto DOPO il claim: la riga sorgente è `failed`, riproponibile. */
  | "action_failed"
  /**
   * 17 set 2026, solo per `reassign_project`: sul progetto scelto esiste già
   * una proposta APERTA per questo messaggio. **Non è un guasto** — è
   * un'informazione utile (la card che si voleva creare c'è già), e va
   * MOSTRATA a chi ha confermato, non ingoiata.
   */
  | "already_proposed";

export type AnswerGoogleProposalResult =
  | { ok: true; changedNotificationIds: string[] }
  | { ok: false; error: AnswerGoogleProposalError; handledBy?: HandledBy };

export interface AnswerGoogleProposalInput {
  notificationId: string;
  actor: Actor;
  /** Indice dell'opzione confermata, validato contro le AZIONI persistite. */
  optionIndex?: number;
  /**
   * Più opzioni confermate INSIEME («una mail, più azioni e più progetti», 26
   * set 2026, design §3). Alternativa a `optionIndex`, mai insieme. Ammesse
   * solo quelle che `multiSelectableIndices` dichiara sommabili — la STESSA
   * regola con cui `readGoogle` mostra le caselle — altrimenti
   * `invalid_answer`, prima di qualunque claim.
   */
  optionIndices?: number[];
  /**
   * Il progetto di destinazione, **solo** per l'azione `reassign_project`
   * (17 set 2026, design §3.1bis). È l'unico dato di payload che viaggia dal
   * client verso il server in tutta questa superficie, e le tre condizioni
   * che lo tengono stretto stanno in {@link answerGoogleProposal}:
   * `optionIndex` resta obbligatorio, su ogni ALTRA azione questo campo è
   * RIFIUTATO (non ignorato), e il progetto viene validato. Il ragionamento
   * per esteso è nel docblock di `inboxGoogleActionSchema`
   * (`@stubwise/shared`), accanto all'invariante che spiega.
   */
  projectId?: string;
}

/**
 * UNA azione della proposta come persistita nel jsonb, ridichiarata come
 * SCHEMA runtime (non basta il tipo `GoogleProposalAction`: qui arriva un
 * `unknown` da un jsonb scritto forse mesi fa). Rispecchia l'unione di
 * `@stubwise/notifications/format.ts`.
 */
const storedActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_backlog_item"),
    projectId: z.string().min(1),
    title: z.string().min(1),
    body: z.string().optional(),
  }),
  z.object({
    type: z.literal("create_milestone"),
    projectId: z.string().min(1),
    name: z.string().min(1),
    dueDate: z.string().optional(),
  }),
  z.object({
    type: z.literal("update_ticket"),
    ticketId: z.string().min(1),
    status: ticketStatusSchema.optional(),
    priority: ticketPrioritySchema.optional(),
  }),
  z.object({ type: z.literal("comment_ticket"), ticketId: z.string().min(1), body: z.string().min(1) }),
  z.object({
    type: z.literal("record_decision"),
    projectId: z.string().min(1),
    ticketId: z.string().min(1).optional(),
    title: z.string().min(1),
    decision: z.string().min(1),
  }),
  z.object({ type: z.literal("choose_project"), projectId: z.string().min(1) }),
  /** Fase 7b: l'occorrenza di una serie con `action: "reminder"`. Nessun payload. */
  z.object({ type: z.literal("acknowledge_reminder") }),
  /**
   * 17 set 2026: sposta QUESTA proposta di posta su un altro progetto.
   *
   * ⚠️ **Nessun payload, e non è una dimenticanza** (design §3.1bis): al
   * momento della publish il progetto di destinazione non esiste ancora come
   * dato — è ciò che l'utente sceglierà. L'opzione persistita è un marcatore
   * di CAPACITÀ, come `acknowledge_reminder`; il progetto arriva alla
   * CONFERMA in `AnswerGoogleProposalInput.projectId`, alle tre condizioni
   * verificate in {@link answerGoogleProposal}.
   */
  z.object({ type: z.literal("reassign_project") }),
  z.object({ type: z.literal("ignore") }),
]);
type StoredAction = z.infer<typeof storedActionSchema>;

/**
 * Quel poco del payload persistito che serve a eseguire: l'ancora
 * (`proposalId`), le AZIONI (indicizzate da `optionIndex`), le opzioni (per
 * l'etichetta della scelta — la nota Slack e il template della decisione la
 * usano, mai la prosa del modello) e `from`/`subject` (NON fidati, entrano
 * solo in parametri di template). Volutamente PARZIALE, come `pulsePayloadSchema`
 * in `./pulse.ts`: un evento scritto da una versione precedente deve restare
 * azionabile finché porta ciò che conta.
 */
const storedEventSchema = z.object({
  proposalId: z.string().min(1),
  /** `"email"` o `"calendar"`: serve a {@link multiSelectableIndices}. Un valore illeggibile non è sommabile. */
  source: z.string().catch(""),
  from: z.string().catch(""),
  subject: z.string().catch(""),
  options: z.array(z.object({ label: z.string().min(1) })).min(1),
  actions: z.array(z.unknown()).min(1),
});

/**
 * Dove sta la riga d'origine, e quanto serve a chiuderla o a costruire la
 * sourceKey/il link.
 *
 * Fase 6b: per l'email NORMALE, `rowId` è ormai l'id del FIGLIO
 * (`email_proposals`), non più del messaggio — è la riga che le azioni
 * chiudono. `emailMessageId` porta l'id del PADRE (`email_messages`), che
 * serve solo a toccarne `updated_at` (vedi {@link markSourceOutcome}/
 * {@link markSourceFailed}), mai a scriverne lo stato. `projectId` è il
 * progetto della proposta: quello del figlio per l'email, quello dell'evento
 * per il calendario (che resta uno-a-uno, quindi non ha bisogno di un
 * figlio).
 *
 * Fase 6c (Task 5): `source: "email_triage"` è un TERZO valore — la proposta
 * di SMISTAMENTO, che vive SUL PADRE (non c'è nessun figlio, per
 * costruzione). Qui `rowId` **e** `emailMessageId` puntano alla STESSA riga
 * (`email_messages.id`): la riga sorgente È il padre. Il distinguo da
 * `source: "email"` non è cosmetico — {@link markSourceOutcome} e
 * {@link markSourceFailed} scrivono su tabelle DIVERSE a seconda del valore
 * (email_proposals+padre per `"email"`, solo il padre per
 * `"email_triage"`), e il case `"choose_project"` di {@link dispatchAction}
 * ha un comportamento DIVERSO sui due — vedi il commento sopra quel case.
 */
interface ProposalSource {
  source: "email" | "calendar" | "email_triage";
  /**
   * `email_proposals.id` per `"email"`, `calendar_events.id` per
   * `"calendar"`, `email_messages.id` (il PADRE) per `"email_triage"`.
   */
  rowId: string;
  /**
   * Per `source: "email"`: `email_messages.id`, il PADRE del figlio sopra.
   * Per `source: "email_triage"`: lo STESSO valore di `rowId` (la riga
   * sorgente È il padre). `null` solo per `"calendar"`.
   */
  emailMessageId: string | null;
  /** Il progetto della proposta (figlio per l'email, evento per il calendario; `null` per lo smistamento — è ciò che manca). */
  projectId: string | null;
  gmailMessageId: string | null;
  /** Per `"email"`/`"email_triage"`: serve al permalink del thread (vedi {@link gmailThreadUrl}). */
  threadId: string | null;
  /** Per `"email"`/`"email_triage"`: `google_accounts.email` della casella, idem. */
  mailboxEmail: string | null;
  googleEventId: string | null;
}

/**
 * Ritrova la riga d'origine dalla notifica: prima il FIGLIO `email_proposals`
 * (fase 6b: è lì che vive `proposal_notification_id` per l'email NORMALE,
 * ormai per ogni riga di quel tipo — anche quelle nate PRIMA di questa fase,
 * che il backfill della migrazione 0070 ha già coperto con una riga figlia
 * equivalente, ereditando lo stesso `proposal_notification_id` dal padre),
 * poi il PADRE `email_messages` (fase 6c, Task 5: la proposta di
 * SMISTAMENTO, che quella colonna la scrive di nuovo — solo per questo caso,
 * vedi `apps/worker/src/google/classify.ts`), infine `calendar_events` (il
 * calendario resta uno a uno, invariato: nessun figlio per lui). Le tre
 * tabelle/condizioni sono a somma esclusiva per costruzione
 * (`publishProposal` lega la notifica a UNA sola riga, nella stessa
 * transazione della publish): al più una delle tre SELECT torna una riga.
 */
async function findSourceRow(db: DbOrTx, notificationId: string): Promise<ProposalSource | null> {
  const [emailRow] = await db
    .select({
      id: emailProposals.id,
      emailMessageId: emailProposals.emailMessageId,
      projectId: emailProposals.projectId,
      gmailMessageId: emailMessages.gmailMessageId,
      threadId: emailMessages.threadId,
      mailboxEmail: googleAccounts.email,
    })
    .from(emailProposals)
    .innerJoin(emailMessages, eq(emailMessages.id, emailProposals.emailMessageId))
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .where(eq(emailProposals.proposalNotificationId, notificationId));
  if (emailRow) {
    return {
      source: "email",
      rowId: emailRow.id,
      emailMessageId: emailRow.emailMessageId,
      projectId: emailRow.projectId,
      gmailMessageId: emailRow.gmailMessageId,
      threadId: emailRow.threadId,
      mailboxEmail: emailRow.mailboxEmail,
      googleEventId: null,
    };
  }

  const [triageRow] = await db
    .select({
      id: emailMessages.id,
      projectId: emailMessages.projectId,
      gmailMessageId: emailMessages.gmailMessageId,
      threadId: emailMessages.threadId,
      mailboxEmail: googleAccounts.email,
    })
    .from(emailMessages)
    .innerJoin(googleAccounts, eq(googleAccounts.id, emailMessages.accountId))
    .where(eq(emailMessages.proposalNotificationId, notificationId));
  if (triageRow) {
    return {
      source: "email_triage",
      rowId: triageRow.id,
      emailMessageId: triageRow.id,
      projectId: triageRow.projectId,
      gmailMessageId: triageRow.gmailMessageId,
      threadId: triageRow.threadId,
      mailboxEmail: triageRow.mailboxEmail,
      googleEventId: null,
    };
  }

  const [calendarRow] = await db
    .select({ id: calendarEvents.id, googleEventId: calendarEvents.googleEventId, projectId: calendarEvents.projectId })
    .from(calendarEvents)
    .where(eq(calendarEvents.proposalNotificationId, notificationId));
  if (calendarRow) {
    return {
      source: "calendar",
      rowId: calendarRow.id,
      emailMessageId: null,
      projectId: calendarRow.projectId,
      gmailMessageId: null,
      threadId: null,
      mailboxEmail: null,
      googleEventId: calendarRow.googleEventId,
    };
  }
  return null;
}

/**
 * Permalink al THREAD Gmail, per il link nel commento di sistema.
 *
 * Duplicata (non importata) da `apps/worker/src/google/proposal.ts`
 * (`gmailThreadUrl`): il worker non è un package condiviso e il server non ne
 * dipende — è una funzione pura di due righe, e tenerne una copia qui costa
 * meno che aprire un package solo per lei. Stessa forma, stessa ragione
 * (`u/<email>/` e non `u/0/`, `#all/` e non `#inbox/`): vedi il docblock
 * gemello nel worker.
 */
function gmailThreadUrl(mailboxEmail: string, threadId: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(mailboxEmail)}/#all/${threadId}`;
}

/**
 * Chiude la riga sorgente con un ESITO riuscito (o ignorato).
 *
 * Fase 6b: per l'email NORMALE (`source: "email"`) la scrittura è ormai sul
 * FIGLIO (`email_proposals`, `source.rowId`) — non più sul messaggio: è così
 * che confermare UNA proposta non chiude più le sue sorelle sullo stesso
 * messaggio. Nella STESSA transazione (`tx` è già quella di
 * {@link dispatchAction}, o quella aperta da {@link markSourceFailed} per il
 * ramo fallito) il padre (`email_messages`) viene toccato SOLO per
 * aggiornare `updated_at` — serve alla retention, che misura la potabilità su
 * quella colonna; nessun altro campo del padre si scrive qui, lo stato
 * aggregato si calcola in lettura altrove.
 *
 * Fase 6c (Task 5): per `source: "email_triage"` NON c'è un figlio da
 * chiudere — la riga sorgente È GIÀ il padre (`source.rowId ===
 * source.emailMessageId`). Si scrive quindi DIRETTAMENTE su
 * `email_messages`: `status` prende lo stesso valore di `outcome.status`
 * (mai 'proposed'/'classified'/'new': la proposta di smistamento è chiusa),
 * `outcome` porta l'esito. Non serve un secondo UPDATE per `updated_at` come
 * nel ramo `"email"` sopra — è già la stessa riga che si sta scrivendo qui.
 *
 * `calendar_events` resta uno a uno e invariato: non ha un figlio, quindi
 * niente updated_at-only-sul-padre da fare per lui. La sua `status` è quella
 * di GOOGLE (`confirmed`/`tentative`/`cancelled`, sotto un CHECK che
 * rifiuterebbe `actioned`) — quindi lì il solo `outcome` jsonb distingue
 * "ancora da proporre" (`null`, vedi `isReadyForProposal`) da "chiusa".
 */
async function markSourceOutcome(
  tx: DbOrTx,
  source: ProposalSource,
  outcome: { status: "actioned" | "ignored"; detail: Record<string, unknown> },
): Promise<void> {
  if (source.source === "email") {
    await tx
      .update(emailProposals)
      .set({ status: outcome.status, outcome: outcome.detail, error: null })
      .where(eq(emailProposals.id, source.rowId));
    // Solo `updated_at`: nessun altro campo del padre cambia qui (vedi il docblock sopra).
    await tx.update(emailMessages).set({ updatedAt: new Date() }).where(eq(emailMessages.id, source.emailMessageId!));
    return;
  }
  if (source.source === "email_triage") {
    await tx
      .update(emailMessages)
      .set({ status: outcome.status, outcome: outcome.detail, error: null })
      .where(eq(emailMessages.id, source.rowId));
    return;
  }
  await tx.update(calendarEvents).set({ outcome: outcome.detail }).where(eq(calendarEvents.id, source.rowId));
}

/** Il tetto di caratteri del messaggio scritto su `email_messages.error` / `outcome.error`. */
const MAX_ERROR_CHARS = 500;

/** Riduce un errore qualunque a un messaggio TECNICO corto — mai il testo dell'email. */
function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

/**
 * Chiude la riga sorgente su un FALLIMENTO (dopo il claim): riproponibile.
 *
 * Come {@link markSourceOutcome}: per `source: "email"` scrive sul FIGLIO
 * (`email_proposals`) e tocca SOLO `updated_at` del padre, nella STESSA
 * transazione (qui aperta da questa funzione: a differenza di
 * `markSourceOutcome`, che riceve la `tx` già aperta di {@link dispatchAction},
 * questa è chiamata FUORI da quella transazione — dopo un `target_gone` o
 * un'eccezione — quindi ne serve una propria); per `source: "email_triage"`
 * (fase 6c) scrive DIRETTAMENTE su `email_messages` — la riga sorgente È il
 * padre, nessun figlio da chiudere né updated_at-a-parte da toccare.
 */
async function markSourceFailed(db: Db, source: ProposalSource, error: string): Promise<void> {
  const truncated = errorMessage(error);
  if (source.source === "email") {
    await db.transaction(async (tx) => {
      await tx
        .update(emailProposals)
        .set({ status: "failed", error: truncated })
        .where(eq(emailProposals.id, source.rowId));
      await tx.update(emailMessages).set({ updatedAt: new Date() }).where(eq(emailMessages.id, source.emailMessageId!));
    });
    return;
  }
  if (source.source === "email_triage") {
    await db
      .update(emailMessages)
      .set({ status: "failed", error: truncated })
      .where(eq(emailMessages.id, source.rowId));
    return;
  }
  await db
    .update(calendarEvents)
    .set({ outcome: { type: "failed", error: truncated } })
    .where(eq(calendarEvents.id, source.rowId));
}

/**
 * Le azioni proposte dal MODELLO — le sole che si sommano, vedi
 * `multiSelectableIndices` in `@stubwise/shared`.
 */
type ModelAction = Extract<
  StoredAction,
  { type: "create_backlog_item" | "create_milestone" | "update_ticket" | "comment_ticket" | "record_decision" }
>;

type ApplyResult = { ok: true; detail: Record<string, unknown> } | { ok: false; error: "target_gone" };

/**
 * ESEGUE un'azione del modello nella transazione data, SENZA chiudere la riga
 * sorgente: restituisce l'esito, e decide il chiamante come chiudere — con
 * quell'esito solo ({@link dispatchAction}) o con tutti insieme
 * ({@link dispatchMultiple}). Il corpo è quello che prima stava nei cinque
 * `case` di `dispatchAction`, invariato.
 *
 * `decisionKeySuffix` distingue le decisioni scelte INSIEME sulla stessa mail:
 * l'idempotenza di `recordDecision` è `(projectId, sourceKey)`, e due decisioni
 * con la stessa chiave ne scriverebbero una sola.
 */
async function applyModelAction(
  tx: DbOrTx,
  args: {
    action: ModelAction;
    source: ProposalSource;
    actor: Actor;
    lang: Language;
    from: string;
    subject: string;
    optionLabel: string;
    proposalId: string;
    notificationId: string;
    decisionKeySuffix?: string;
  },
): Promise<ApplyResult> {
  switch (args.action.type) {
    case "create_backlog_item": {
      const result = await enqueueBacklogIntake(tx, {
        projectId: args.action.projectId,
        title: args.action.title,
        // Il payload d'intake vuole un corpo NON VUOTO: se la proposta non
        // ne aveva uno (il classificatore non l'ha scritto), si ripiega
        // sull'oggetto della email e, in ultima istanza, sull'etichetta
        // dell'opzione — mai una stringa fissa senza contesto.
        body: nonEmpty(args.action.body, args.subject, args.optionLabel),
      });
      if (!result.ok) return { ok: false, error: "target_gone" };
      return { ok: true, detail: { type: "backlog_item", jobId: result.jobId } };
    }
    case "create_milestone": {
      const result = await createMilestone(tx, {
        projectId: args.action.projectId,
        name: args.action.name,
        dueDate: args.action.dueDate ?? null,
      });
      if (!result.ok) {
        if (result.error === "milestone_exists") {
          // NON è un errore per chi ha confermato: voleva quella milestone,
          // e già esiste. Outcome di successo, non `target_gone`.
          return { ok: true, detail: { type: "exists" } };
        }
        return { ok: false, error: "target_gone" };
      }
      return { ok: true, detail: { type: "milestone", milestoneId: result.milestone.id } };
    }
    case "update_ticket": {
      const result = await patchTicket(tx, {
        ticketId: args.action.ticketId,
        actorId: args.actor.id,
        patch: {
          ...(args.action.status ? { status: args.action.status } : {}),
          ...(args.action.priority ? { priority: args.action.priority } : {}),
        },
      });
      if (!result.ok) return { ok: false, error: "target_gone" };
      return { ok: true, detail: { type: "ticket_updated", ticketId: args.action.ticketId } };
    }
    case "comment_ticket": {
      // Il worker non genera MAI questa azione per un evento di calendario
      // (nessun `threadId` da linkare): stessa anomalia di `choose_project`
      // qui sotto — si lascia rientrare la transazione, `action_failed`.
      if (args.source.source !== "email" || !args.source.threadId || !args.source.mailboxEmail) {
        throw new Error("comment_ticket richiede una proposta email con thread noto");
      }
      // `addSystemComment` NON verifica che il ticket esista (è compito del
      // chiamante, vedi il suo docblock): lo si controlla qui.
      const [ticket] = await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, args.action.ticketId));
      if (!ticket) return { ok: false, error: "target_gone" };
      await addSystemComment(tx, {
        ticketId: args.action.ticketId,
        body: t(args.lang, "email.execution.commentBody", {
          body: args.action.body,
          link: gmailThreadUrl(args.source.mailboxEmail, args.source.threadId),
        }),
      });
      return { ok: true, detail: { type: "commented", ticketId: args.action.ticketId } };
    }
    case "record_decision": {
      const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, args.action.projectId));
      if (!project) return { ok: false, error: "target_gone" };
      // `sourceKey` è l'ancora di IDEMPOTENZA di `recordDecision`: una email
      // (il caso previsto, vedi il docblock del modulo) o — difensivamente,
      // per un jsonb malformato che indicizzasse un evento di calendario —
      // l'evento stesso. Nessuno dei due può mancare: `findSourceRow` ha già
      // stabilito da quale tabella viene `args.source`.
      const sourceKey = `${
        args.source.source === "email"
          ? `email:${args.source.gmailMessageId}`
          : `calendar:${args.source.googleEventId}`
      }${args.decisionKeySuffix ?? ""}`;
      // ⚠️ MAI `args.action.title`/`args.action.decision` (prosa del
      // classificatore, sia pure rivalidata): il registro decisioni li
      // ignora di proposito e compone il fatto SOLO da `from`, `subject` e
      // l'etichetta già templata dell'opzione scelta — vedi il docblock del
      // modulo e `decision.email.*` in `packages/i18n`.
      await recordDecision(tx, {
        projectId: args.action.projectId,
        source: "email",
        sourceKey,
        sourceRef: { proposalId: args.proposalId, notificationId: args.notificationId },
        ...(args.action.ticketId ? { ticketId: args.action.ticketId } : {}),
        title: t(args.lang, "decision.email.title", { subject: args.subject }),
        decision: t(args.lang, "decision.email.decision", {
          from: args.from,
          subject: args.subject,
          option: args.optionLabel,
        }),
        decidedByUserId: args.actor.id,
      });
      return { ok: true, detail: { type: "decision_recorded" } };
    }
  }
}

/**
 * L'esito del dispatch. `target_gone` e — dal 17 set 2026, per la sola
 * `reassign_project` — `already_proposed` sono i soli errori tipizzati che
 * possono risalire da qui.
 */
type DispatchResult = { ok: true } | { ok: false; error: "target_gone" | "already_proposed" };

/**
 * Gli stati di `email_proposals` in cui una proposta è ancora APERTA: nessuno
 * ha ancora deciso. Sono il complemento dei terminali
 * (`actioned`/`ignored`/`failed`) su cui è scritta la retention della 6b —
 * elencati in positivo, così un valore NUOVO dell'enum non finirebbe per
 * sbaglio a contare come «aperta».
 */
const OPEN_PROPOSAL_STATUSES = ["classified", "proposed"] as const;

/**
 * Il pre-check di `reassign_project`, PRIMA del claim: il progetto scelto
 * esiste ancora, e su di lui non c'è già una proposta aperta per questo
 * messaggio.
 *
 * ⚠️ Non è l'autorità — è una corsa, e il controllo che decide davvero sta
 * nella transazione di {@link dispatchAction}. Esiste perché senza, una
 * riattribuzione verso un progetto che ha già la sua card avrebbe pagato il
 * claim: `propagateHandled` chiude la notifica e il ramo d'errore marca la
 * riga `failed` — una proposta legittima persa per un gesto che non cambia
 * niente.
 *
 * L'insert del ramo di dispatch ha `onConflictDoUpdate` su
 * `(email_message_id, project_id)` per il fan-out del worker: senza questi
 * due controlli, riattribuire su un progetto già proposto SOVRASCRIVEREBBE
 * quella card in silenzio.
 */
async function reassignPrecheck(
  db: Db,
  source: ProposalSource,
  targetProjectId: string,
): Promise<"target_gone" | "already_proposed" | null> {
  const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, targetProjectId));
  if (!project) return "target_gone";
  const [existing] = await db
    .select({ id: emailProposals.id })
    .from(emailProposals)
    .where(
      and(
        eq(emailProposals.emailMessageId, source.emailMessageId!),
        eq(emailProposals.projectId, targetProjectId),
        inArray(emailProposals.status, [...OPEN_PROPOSAL_STATUSES]),
      ),
    );
  return existing ? "already_proposed" : null;
}

/**
 * Esegue l'AZIONE dentro una transazione propria: o l'azione e la chiusura
 * della riga sorgente sono scritte insieme, o non lo è nessuna delle due (un
 * `target_gone` non ha scritto nulla — si ritorna PRIMA di ogni mutazione — e
 * un'eccezione fa rientrare la transazione, lasciando il richiamante libero di
 * marcare `failed` con una scrittura separata).
 */
async function dispatchAction(
  db: Db,
  args: {
    action: StoredAction;
    source: ProposalSource;
    actor: Actor;
    lang: Language;
    from: string;
    subject: string;
    optionLabel: string;
    proposalId: string;
    notificationId: string;
    /** Solo per `reassign_project`: il progetto scelto alla conferma (design §3.1bis). */
    targetProjectId?: string;
  },
): Promise<DispatchResult> {
  return db.transaction(async (tx) => {
    switch (args.action.type) {
      case "create_backlog_item":
      case "create_milestone":
      case "update_ticket":
      case "comment_ticket":
      case "record_decision": {
        const applied = await applyModelAction(tx, { ...args, action: args.action });
        if (!applied.ok) return applied;
        await markSourceOutcome(tx, args.source, { status: "actioned", detail: applied.detail });
        return { ok: true };
      }
      case "choose_project": {
        // ⚠️ DUE SEMANTICHE DIVERSE PER LA STESSA AZIONE, e COESISTONO DI
        // PROPOSITO (fase 6c, Task 5) — è la ragione per cui `choose_project`
        // non è mai stata rimossa dall'unione (`@stubwise/notifications`),
        // solo deprecata in GENERAZIONE per i figli (fase 6b):
        //
        //  1. **`source.source === "email_triage"` (il PADRE, proposta di
        //     SMISTAMENTO — fase 6c, VIVA)**: il messaggio non ha NESSUN
        //     progetto attribuito, è esattamente ciò che questa proposta
        //     chiede. Scegliere un'opzione ASSEGNA il perimetro
        //     (`scope_project_ids = [projectId]`, un perimetro di UN SOLO
        //     progetto: quello scelto — non un candidato in più, la scelta
        //     dell'utente decide) **e ANCHE `project_id`** — non solo il
        //     perimetro: `classify.ts`/`loadContext` legge
        //     `resolvedProjectId` da `email_messages.project_id`, e con un
        //     perimetro di UN SOLO progetto le istruzioni del prompt
        //     ESENTANO il modello dal ripetere `projectId` su ogni proposta
        //     ("non ometterlo mai quando i progetti elencati sono più di
        //     uno" implica che con UNO solo può ometterlo). Senza
        //     `resolvedProjectId` risolto, `revalidateProposal` non
        //     potrebbe completare un `projectId` omesso e la riclassificazione
        //     ricadrebbe di nuovo in smistamento — un loop che vanifica la
        //     scelta appena fatta — e RIMETTE IL MESSAGGIO IN CODA di
        //     classificazione (`status = 'new'`, `proposal_notification_id
        //     = NULL`). Il prossimo tick lo riclassifica con un perimetro
        //     NON vuoto e un vincitore risolto, e la classificazione normale
        //     (fase 6b) crea il figlio per quel progetto — da lì nascono le
        //     proposte vere. Questo ramo NON passa da `markSourceOutcome`: il
        //     messaggio non viene "chiuso" (`actioned`/`ignored`), torna
        //     ATTIVO.
        //
        //  2. **`source.source === "email"` (un FIGLIO, proposta STORICA,
        //     fase 6b commit 72803b8, DEPRECATA in generazione)**:
        //     comportamento INVARIATO da prima di questo task — chiude SOLO
        //     il figlio corrente con l'outcome `reassigned_project`, NON
        //     sposta `email_proposals.project_id`, NON tocca
        //     `email_messages.status` oltre `updated_at` (via
        //     `markSourceOutcome`). Resta eseguibile solo per le card
        //     pubblicate PRIMA della fase 6b — vedi il docblock del tipo in
        //     `@stubwise/notifications/format.ts`. NON TOCCARE questo ramo
        //     per il ramo 1: sono percorsi indipendenti, la sola cosa in
        //     comune è il controllo che il progetto esista ancora.
        //
        // Il worker non genera MAI questa azione per un evento di
        // calendario (`buildCalendarProposalEvent` propone SOLO l'azione
        // configurata sulla serie — `create_backlog_item`, `create_milestone`
        // o `acknowledge_reminder`, fase 7b — più `ignore`, mai
        // `choose_project`): un jsonb che la persistisse lì sopra sarebbe
        // un'anomalia, non un `target_gone` — si lascia rientrare la
        // transazione con un'eccezione, che il chiamante marca
        // `action_failed`.
        if (args.source.source === "calendar") {
          throw new Error("choose_project non è prevista su una proposta da calendario");
        }
        const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, args.action.projectId));
        if (!project) return { ok: false, error: "target_gone" };

        if (args.source.source === "email_triage") {
          // Ramo 1 — vedi il commento sopra. Riaccoda il PADRE, non lo
          // "chiude": nessuna scrittura tramite `markSourceOutcome`.
          // `projectId` E `scopeProjectIds` insieme: il primo risolve
          // `resolvedProjectId` alla riclassificazione, il secondo è il
          // perimetro che porta il candidato a `loadContext`.
          await tx
            .update(emailMessages)
            .set({
              status: "new",
              projectId: args.action.projectId,
              scopeProjectIds: [args.action.projectId],
              proposalNotificationId: null,
              error: null,
            })
            .where(eq(emailMessages.id, args.source.rowId));
          return { ok: true };
        }

        // Ramo 2 — `args.source.source === "email"`: comportamento STORICO,
        // deprecato in generazione, INVARIATO da prima di questo task.
        await markSourceOutcome(tx, args.source, {
          status: "actioned",
          detail: { type: "reassigned_project", projectId: args.action.projectId },
        });
        return { ok: true };
      }
      case "reassign_project": {
        // 17 set 2026 — SPOSTARE QUESTA PROPOSTA SU UN ALTRO PROGETTO.
        //
        // ⚠️ **NON è `choose_project`**, e la distanza è tutta qui: quel nome
        // ha già due semantiche opposte (sul padre riapre lo smistamento, sul
        // figlio chiude con `reassigned_project`) che CLAUDE.md vieta
        // esplicitamente di unificare. Questa è una TERZA cosa, con un nome
        // suo, e in particolare — a differenza del ramo 2 di
        // `choose_project` — **crea davvero la riga sul progetto scelto**.
        //
        // Quello che questo ramo NON tocca, ed è l'invariante della 6b che
        // questo batch è il candidato più probabile a incrinare: le proposte
        // SORELLE (le altre righe `email_proposals` dello stesso messaggio)
        // e il PADRE (`email_messages`), toccato SOLO in `updated_at` — mai
        // `status`, mai `project_id`, mai `scope_project_ids`, mai
        // `proposal_notification_id`. `project_id`/`scope_project_ids` sono
        // ciò che il ROUTING aveva dedotto: restano com'erano, anche dopo che
        // una persona ha corretto una singola proposta.
        //
        // Il tetto `GMAIL_MAX_PROJECTS_PER_MESSAGE` non si applica: contiene
        // il fan-out AUTOMATICO, non una scelta umana.
        if (args.source.source !== "email" || args.targetProjectId === undefined) {
          throw new Error("reassign_project richiede una proposta email figlia e un progetto scelto");
        }
        const targetProjectId = args.targetProjectId;
        const [target] = await tx
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(eq(projects.id, targetProjectId));
        if (!target) return { ok: false, error: "target_gone" };

        // ⚠️ IL CONTROLLO CHE FA AUTORITÀ. Il pre-check prima del claim è una
        // corsa; questo no. Senza, l'`onConflictDoUpdate` dell'insert qui
        // sotto sovrascriverebbe IN SILENZIO una card legittima già aperta
        // sul progetto scelto.
        const [conflict] = await tx
          .select({ id: emailProposals.id })
          .from(emailProposals)
          .where(
            and(
              eq(emailProposals.emailMessageId, args.source.emailMessageId!),
              eq(emailProposals.projectId, targetProjectId),
              inArray(emailProposals.status, [...OPEN_PROPOSAL_STATUSES]),
            ),
          );
        if (conflict) return { ok: false, error: "already_proposed" };

        const [current] = await tx
          .select({ classification: emailProposals.classification, projectId: emailProposals.projectId })
          .from(emailProposals)
          .where(eq(emailProposals.id, args.source.rowId));
        if (!current) return { ok: false, error: "target_gone" };

        // La riga NUOVA nasce `classified` e SENZA notifica: è esattamente lo
        // stato in cui il poller del worker pesca una proposta da pubblicare.
        // Il marcatore `needsReclassification` dice al worker di rifare i
        // suggerimenti col contesto del progetto NUOVO prima di pubblicare —
        // la classificazione corrente parlava di un altro progetto, e
        // pubblicarla così com'è sarebbe peggio che non pubblicarla.
        // `reassignedFrom` conserva da dove è arrivata: senza, la riga
        // rigenerata non saprebbe più raccontare la propria storia.
        await tx
          .insert(emailProposals)
          .values({
            emailMessageId: args.source.emailMessageId!,
            projectId: targetProjectId,
            status: "classified",
            classification: {
              ...current.classification,
              reassignedFrom: current.projectId,
              needsReclassification: true,
            },
            proposalNotificationId: null,
            outcome: null,
            error: null,
          })
          .onConflictDoUpdate({
            target: [emailProposals.emailMessageId, emailProposals.projectId],
            set: {
              status: "classified",
              classification: {
                ...current.classification,
                reassignedFrom: current.projectId,
                needsReclassification: true,
              },
              proposalNotificationId: null,
              outcome: null,
              error: null,
            },
          });

        // Chiude la proposta corrente — mai un `ignored` NUDO: l'esito dice
        // DOVE è andata, così una card fra le gestite resta leggibile
        // (stessa forma di `superseded_in_thread` e di `declined`).
        await markSourceOutcome(tx, args.source, {
          status: "ignored",
          detail: { type: "reassigned_to", projectId: targetProjectId },
        });

        // Il registro annota IL TAP, mai la prosa del classificatore: testo
        // da template i18n, sul progetto che la proposta LASCIA — è lì che
        // sparisce una card, ed è lì che serve saperne il perché. `sourceKey`
        // porta il progetto di destinazione perché l'idempotenza di
        // `recordDecision` è `(projectId, sourceKey)`: due riattribuzioni
        // diverse dello stesso messaggio sono due fatti diversi.
        const [fromProject] = await tx
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(eq(projects.id, current.projectId));
        if (fromProject) {
          await recordDecision(tx, {
            projectId: fromProject.id,
            source: "email",
            sourceKey: `email:${args.source.gmailMessageId}:reassign:${targetProjectId}`,
            sourceRef: { proposalId: args.proposalId, notificationId: args.notificationId },
            title: t(args.lang, "decision.email.title", { subject: args.subject }),
            decision: t(args.lang, "decision.email.reassigned", {
              from: args.from,
              fromProject: fromProject.name,
              toProject: target.name,
            }),
            decidedByUserId: args.actor.id,
          });
        }
        return { ok: true };
      }
      case "ignore": {
        // Fase 6c: sulla proposta di SMISTAMENTO (`source: "email_triage"`)
        // «Nessuno di questi» non è un `ignored` generico — registra
        // ESPLICITAMENTE che il messaggio è stato smistato e SCARTATO (nessun
        // progetto suggerito era quello giusto), distinguibile in lettura da
        // un `ignored` per assenza di segnale (`outcome` resta `null` in
        // quel caso, vedi `classify.ts`). Sulle altre sorgenti l'esito resta
        // quello generico di sempre.
        const detail =
          args.source.source === "email_triage"
            ? { type: "triage_dismissed" as const }
            : { type: "ignored" as const };
        await markSourceOutcome(tx, args.source, { status: "ignored", detail });
        return { ok: true };
      }
      case "acknowledge_reminder": {
        // Fase 7b: l'occorrenza di una serie con `action: "reminder"`. Nessun
        // oggetto creato — la card STESSA è il promemoria — quindi nessun
        // servizio da chiamare: solo l'esito, distinguibile in lettura da un
        // `ignore` generico (l'utente ha detto "sì, ricordamelo", non
        // "questo non mi interessa").
        await markSourceOutcome(tx, args.source, { status: "actioned", detail: { type: "reminder" } });
        return { ok: true };
      }
    }
  });
}

/** Il primo valore non vuoto (spazi compresi) della lista, per i fallback dei testi generati. */
function nonEmpty(...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (candidate && candidate.trim() !== "") return candidate;
  }
  // Irraggiungibile in pratica: `optionLabel` (l'ultimo candidato passato dai
  // chiamanti) è sempre non vuoto — è validato `min(1)` alla pubblicazione.
  return "—";
}

/**
 * Chi ha già gestito la riga (se lo sappiamo): stessa forma di `./pulse.ts`,
 * ma qui non serve leggere `handled_by_user_id` — `google.proposal` ha UN
 * SOLO destinatario possibile (`notifications.user_id`, l'audience
 * `mailbox_owner`), quindi "chi l'ha gestita" è per forza lui.
 */
async function handledByOf(db: Db, notificationId: string): Promise<{ handledBy?: HandledBy }> {
  const [row] = await db
    .select({ id: users.id, email: users.email })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(eq(notifications.id, notificationId));
  return row ? { handledBy: { id: row.id, email: row.email } } : {};
}

/**
 * Valida una scelta MULTIPLA contro le azioni persistite, prima di qualunque
 * claim. Restituisce gli indici ordinati, o `null` se la richiesta è fuori
 * contratto (`invalid_answer`): insieme a `optionIndex` o a `projectId`,
 * vuota, con duplicati, o con un indice che la regola condivisa non dichiara
 * sommabile — la STESSA con cui `readGoogle` decide dove mostrare le caselle,
 * così il client non può chiedere ciò che non gli è stato offerto.
 */
function validateMultiSelection(
  input: AnswerGoogleProposalInput,
  source: string,
  actions: readonly unknown[],
  optionCount: number,
): number[] | null {
  const indices = input.optionIndices;
  if (!indices || indices.length === 0) return null;
  if (input.optionIndex !== undefined || input.projectId !== undefined) return null;
  if (new Set(indices).size !== indices.length) return null;
  const typed = actions.map((a) => ({
    type: typeof a === "object" && a !== null && typeof (a as { type?: unknown }).type === "string"
      ? (a as { type: string }).type
      : "",
  }));
  const allowed = new Set(multiSelectableIndices(source, typed));
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= optionCount || !allowed.has(i)) return null;
  }
  return [...indices].sort((a, b) => a - b);
}

/** Lanciata DENTRO la transazione multipla per farla rientrare: un `return` la committerebbe. */
class MultipleActionError extends Error {
  constructor(readonly error: "target_gone") {
    super(error);
  }
}

/**
 * Conferma PIÙ azioni insieme («una mail, più azioni e più progetti», design
 * §3). Tutto o niente: le azioni girano in UNA transazione, in ordine
 * d'indice, e la prima che perde il suo referente la fa rientrare intera —
 * nessuna voce creata a metà. La riga sorgente si chiude UNA volta, con
 * l'esito `multiple` che elenca quelli delle singole azioni.
 */
async function answerMultiple(
  db: Db,
  args: {
    input: AnswerGoogleProposalInput;
    row: { status: string };
    proposalId: string;
    from: string;
    subject: string;
    actions: readonly unknown[];
    options: readonly { label: string }[];
    selected: number[];
  },
): Promise<AnswerGoogleProposalResult> {
  const { input, row, proposalId, from, subject, options, selected } = args;
  const { actor } = input;

  const chosen: { index: number; action: ModelAction; label: string }[] = [];
  for (const index of selected) {
    const parsed = storedActionSchema.safeParse(args.actions[index]);
    if (!parsed.success) return { ok: false, error: "proposal_stale" };
    // `multiSelectableIndices` ha già filtrato per tipo: qui è solo il parse.
    chosen.push({ index, action: parsed.data as ModelAction, label: options[index]!.label });
  }

  if (row.status !== "open") {
    return { ok: false, error: "already_handled", ...(await handledByOf(db, input.notificationId)) };
  }
  const source = await findSourceRow(db, input.notificationId);
  // Le azioni sommabili esistono solo sulle proposte di posta FIGLIE.
  if (!source || source.source !== "email") return { ok: false, error: "proposal_stale" };

  const changedNotificationIds = await propagateHandled(
    db,
    { eventKey: { kind: "google_proposal", field: "proposalId", value: proposalId } },
    actor.id,
  );
  if (changedNotificationIds.length === 0) {
    return { ok: false, error: "already_handled", ...(await handledByOf(db, input.notificationId)) };
  }

  const lang = await getContentLanguage(db);

  try {
    await db.transaction(async (tx) => {
      const results: Record<string, unknown>[] = [];
      for (const { index, action, label } of chosen) {
        const applied = await applyModelAction(tx, {
          action,
          source,
          actor,
          lang,
          from,
          subject,
          optionLabel: label,
          proposalId,
          notificationId: input.notificationId,
          // Una chiave per decisione: con la stessa, `recordDecision` ne terrebbe una sola.
          decisionKeySuffix: `#${index}`,
        });
        if (!applied.ok) throw new MultipleActionError(applied.error);
        results.push(applied.detail);
      }
      await markSourceOutcome(tx, source, { status: "actioned", detail: { type: "multiple", results } });
    });
  } catch (err) {
    if (err instanceof MultipleActionError) {
      await markSourceFailed(db, source, `google.proposal: ${err.error} (multiple)`);
      return { ok: false, error: err.error };
    }
    await markSourceFailed(db, source, errorMessage(err));
    return { ok: false, error: "action_failed" };
  }

  await mirrorDecision(db, {
    notificationIds: changedNotificationIds,
    action: "answer",
    actorId: actor.id,
    answer: chosen.map((c) => c.label).join("; "),
  });

  return { ok: true, changedNotificationIds };
}

/**
 * Conferma UN'opzione di una proposta Google: dalla lettura al claim, dal
 * claim al dispatch dell'azione, per la sola persona a cui la proposta è
 * rivolta. Vedi il docblock del modulo per l'ordine delle operazioni e il
 * perché di ciascuna.
 */
export async function answerGoogleProposal(
  db: Db,
  input: AnswerGoogleProposalInput,
): Promise<AnswerGoogleProposalResult> {
  const { actor } = input;

  const [row] = await db
    .select({ status: notifications.status, event: notifications.event })
    .from(notifications)
    .where(
      and(
        eq(notifications.id, input.notificationId),
        eq(notifications.kind, "google.proposal"),
        // IL controllo che conta — vedi il docblock del modulo. Una notifica
        // di un altro utente (admin incluso) non produce riga: `not_found`.
        eq(notifications.userId, actor.id),
      ),
    );
  if (!row) return { ok: false, error: "not_found" };

  if (!actorAllows({ kind: "google.proposal", requestedByUserId: null }, "answer", actor)) {
    return { ok: false, error: "forbidden" };
  }

  const parsedEvent = storedEventSchema.safeParse(row.event);
  if (!parsedEvent.success) return { ok: false, error: "proposal_stale" };
  const { proposalId, from, subject, actions, options } = parsedEvent.data;

  // PIÙ OPZIONI INSIEME (26 set 2026). Tutta la validazione sta QUI, prima di
  // qualunque claim: una richiesta fuori contratto non chiude niente.
  let index = input.optionIndex;
  if (input.optionIndices !== undefined) {
    const selected = validateMultiSelection(input, parsedEvent.data.source, actions, options.length);
    if (!selected) return { ok: false, error: "invalid_answer" };
    // Un indice solo è la scelta singola di sempre: stesso percorso, stesso esito.
    if (selected.length === 1) index = selected[0];
    else return answerMultiple(db, { input, row, proposalId, from, subject, actions, options, selected });
  }

  // Validazione di MERITO dell'indice (400): è la richiesta del client a
  // essere fuori range, non il payload persistito a essere malato.
  if (
    index === undefined ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= actions.length ||
    index >= options.length
  ) {
    return { ok: false, error: "invalid_answer" };
  }

  // Da qui in poi un fallimento del parse è il payload a essere malato, non
  // la richiesta: `proposal_stale`, come l'evento intero sopra.
  const parsedAction = storedActionSchema.safeParse(actions[index]);
  if (!parsedAction.success) return { ok: false, error: "proposal_stale" };
  const action = parsedAction.data;
  const optionLabel = options[index]!.label;

  // ⚠️ `projectId` è accettato SOLO se l'azione risolta da quell'indice è
  // `reassign_project`, e su ogni ALTRA azione è RIFIUTATO — non ignorato
  // (design §3.1bis): ignorarlo ne farebbe una porta di servizio che il
  // prossimo che passa usa «tanto c'è». È la richiesta del client a essere
  // fuori contratto, non il payload persistito: `invalid_answer` (400).
  if (input.projectId !== undefined && action.type !== "reassign_project") {
    return { ok: false, error: "invalid_answer" };
  }
  if (action.type === "reassign_project" && (input.projectId === undefined || input.projectId.trim() === "")) {
    return { ok: false, error: "invalid_answer" };
  }

  // Pre-check OTTIMISTICO, prima del claim: una riga non `open` non è
  // azionabile. Il claim sotto è quello che decide DAVVERO sotto concorrenza
  // (stesso schema di `proceedWithProposal`).
  if (row.status !== "open") {
    return { ok: false, error: "already_handled", ...(await handledByOf(db, input.notificationId)) };
  }

  // La riga sorgente non si ritrova più (anomalia: `publishProposal` la lega
  // sempre alla notifica nella STESSA transazione della publish). Trattata
  // come il payload malato qui sopra: non c'è nessun claim da fare o
  // disfare, quindi si esce PRIMA del claim.
  const source = await findSourceRow(db, input.notificationId);
  if (!source) return { ok: false, error: "proposal_stale" };

  if (action.type === "reassign_project") {
    // Offerta SOLO sulle proposte di posta FIGLIE. Su `"calendar"` e su
    // `"email_triage"` è un'anomalia del jsonb, non un `target_gone`: il
    // worker non la genera mai lì (il calendario non ha fan-out, lo
    // smistamento ha già `choose_project`). Si esce PRIMA del claim, quindi
    // non c'è niente da disfare.
    if (source.source !== "email") return { ok: false, error: "proposal_stale" };
    if (input.projectId === source.projectId) return { ok: false, error: "invalid_answer" };
    const precheck = await reassignPrecheck(db, source, input.projectId!);
    // ⚠️ Questo pre-check NON è ridondante con quello in transazione, ed è il
    // punto più facile da sbagliare del batch: senza, `propagateHandled`
    // avrebbe già chiuso la card e il ramo di errore la marcherebbe `failed`
    // — per un gesto che non cambia niente. L'autorità resta il controllo in
    // transazione (questo è una corsa), ma senza questo il costo di perderla
    // lo paga una proposta legittima.
    if (precheck) return { ok: false, error: precheck };
  }

  // CLAIM: da qui in poi, se riesce, siamo l'UNICO esecutore.
  const changedNotificationIds = await propagateHandled(
    db,
    { eventKey: { kind: "google_proposal", field: "proposalId", value: proposalId } },
    actor.id,
  );
  if (changedNotificationIds.length === 0) {
    // Claim perso: qualcun altro ha deciso questa proposta fra il pre-check e
    // ora.
    return { ok: false, error: "already_handled", ...(await handledByOf(db, input.notificationId)) };
  }

  const lang = await getContentLanguage(db);

  try {
    const dispatched = await dispatchAction(db, {
      action,
      source,
      actor,
      lang,
      from,
      subject,
      optionLabel,
      proposalId,
      notificationId: input.notificationId,
      ...(input.projectId !== undefined ? { targetProjectId: input.projectId } : {}),
    });
    if (!dispatched.ok) {
      await markSourceFailed(db, source, `google.proposal: ${dispatched.error} (${action.type})`);
      return { ok: false, error: dispatched.error };
    }
  } catch (err) {
    // Fallimento IMPREVISTO dopo il claim: la riga resta riproponibile, la
    // notifica resta chiusa (nessun secondo tentativo automatico — è la
    // persona, dalla pagina Posta del Task 12, a rimandarla in coda).
    await markSourceFailed(db, source, errorMessage(err));
    return { ok: false, error: "action_failed" };
  }

  // Best-effort, fuori da ogni transazione: riusa la nota generica di
  // `answer` (`notify.inbox.noteAnswered`, "Risposta di {actor}: {answer}")
  // con l'etichetta dell'opzione confermata — nessuna nota dedicata alla
  // posta serve, è la stessa "cosa" che rispondere a una domanda o al pulse:
  // qualcuno ha scelto un'opzione.
  await mirrorDecision(db, {
    notificationIds: changedNotificationIds,
    action: "answer",
    actorId: actor.id,
    answer: optionLabel,
  });

  return { ok: true, changedNotificationIds };
}
