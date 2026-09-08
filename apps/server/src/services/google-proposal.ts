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
import { ticketPrioritySchema, ticketStatusSchema } from "@stubwise/shared";
import { and, eq } from "drizzle-orm";
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
  | "action_failed";

export type AnswerGoogleProposalResult =
  | { ok: true; changedNotificationIds: string[] }
  | { ok: false; error: AnswerGoogleProposalError; handledBy?: HandledBy };

export interface AnswerGoogleProposalInput {
  notificationId: string;
  actor: Actor;
  /** Indice dell'opzione confermata, validato contro le AZIONI persistite. */
  optionIndex?: number;
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
  from: z.string().catch(""),
  subject: z.string().catch(""),
  options: z.array(z.object({ label: z.string().min(1) })).min(1),
  actions: z.array(z.unknown()).min(1),
});

/**
 * Dove sta la riga d'origine, e quanto serve a chiuderla o a costruire la
 * sourceKey/il link.
 *
 * Fase 6b: per l'email, `rowId` è ormai l'id del FIGLIO (`email_proposals`),
 * non più del messaggio — è la riga che le azioni chiudono. `emailMessageId`
 * porta l'id del PADRE (`email_messages`), che serve solo a toccarne
 * `updated_at` (vedi {@link markSourceOutcome}/{@link markSourceFailed}), mai
 * a scriverne lo stato. `projectId` è il progetto della proposta: quello del
 * figlio per l'email, quello dell'evento per il calendario (che resta
 * uno-a-uno, quindi non ha bisogno di un figlio).
 */
interface ProposalSource {
  source: "email" | "calendar";
  /** `email_proposals.id` per l'email, `calendar_events.id` per il calendario. */
  rowId: string;
  /** Solo per `source: "email"`: `email_messages.id`, il PADRE del figlio sopra. */
  emailMessageId: string | null;
  /** Il progetto della proposta (figlio per l'email, evento per il calendario). */
  projectId: string | null;
  gmailMessageId: string | null;
  /** Solo per `source: "email"`: serve al permalink del thread (vedi {@link gmailThreadUrl}). */
  threadId: string | null;
  /** Solo per `source: "email"`: `google_accounts.email` della casella, idem. */
  mailboxEmail: string | null;
  googleEventId: string | null;
}

/**
 * Ritrova la riga d'origine dalla notifica: prima il FIGLIO `email_proposals`
 * (fase 6b: è lì che vive `proposal_notification_id` per l'email, ormai per
 * ogni riga — anche quelle nate PRIMA di questa fase, che il backfill della
 * migrazione 0070 ha già coperto con una riga figlia equivalente, ereditando
 * lo stesso `proposal_notification_id` dal padre), poi `calendar_events` (il
 * calendario resta uno a uno, invariato: nessun figlio per lui). Le due
 * tabelle sono a somma esclusiva per costruzione (`publishProposal` ne lega
 * sempre e solo una, nella stessa transazione della publish): al più una
 * delle due SELECT torna una riga.
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
 * Fase 6b: per l'email la scrittura è ormai sul FIGLIO (`email_proposals`,
 * `source.rowId`) — non più sul messaggio: è così che confermare UNA
 * proposta non chiude più le sue sorelle sullo stesso messaggio. Nella
 * STESSA transazione (`tx` è già quella di {@link dispatchAction}, o quella
 * aperta da {@link markSourceFailed} per il ramo fallito) il padre
 * (`email_messages`) viene toccato SOLO per aggiornare `updated_at` — serve
 * alla retention (Task 7), che misura la potabilità su quella colonna; nessun
 * altro campo del padre si scrive qui, lo stato aggregato si calcola in
 * lettura altrove.
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
 * Come {@link markSourceOutcome}, per l'email scrive sul FIGLIO
 * (`email_proposals`) e tocca SOLO `updated_at` del padre, nella STESSA
 * transazione (qui aperta da questa funzione: a differenza di
 * `markSourceOutcome`, che riceve la `tx` già aperta di {@link dispatchAction},
 * questa è chiamata FUORI da quella transazione — dopo un `target_gone` o
 * un'eccezione — quindi ne serve una propria).
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
  await db
    .update(calendarEvents)
    .set({ outcome: { type: "failed", error: truncated } })
    .where(eq(calendarEvents.id, source.rowId));
}

/** L'esito del dispatch: `target_gone` è l'UNICO errore tipizzato che può risalire da qui. */
type DispatchResult = { ok: true } | { ok: false; error: "target_gone" };

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
  },
): Promise<DispatchResult> {
  return db.transaction(async (tx) => {
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
        await markSourceOutcome(tx, args.source, {
          status: "actioned",
          detail: { type: "backlog_item", jobId: result.jobId },
        });
        return { ok: true };
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
            await markSourceOutcome(tx, args.source, { status: "actioned", detail: { type: "exists" } });
            return { ok: true };
          }
          return { ok: false, error: "target_gone" };
        }
        await markSourceOutcome(tx, args.source, {
          status: "actioned",
          detail: { type: "milestone", milestoneId: result.milestone.id },
        });
        return { ok: true };
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
        await markSourceOutcome(tx, args.source, {
          status: "actioned",
          detail: { type: "ticket_updated", ticketId: args.action.ticketId },
        });
        return { ok: true };
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
        await markSourceOutcome(tx, args.source, {
          status: "actioned",
          detail: { type: "commented", ticketId: args.action.ticketId },
        });
        return { ok: true };
      }
      case "record_decision": {
        const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, args.action.projectId));
        if (!project) return { ok: false, error: "target_gone" };
        // `sourceKey` è l'ancora di IDEMPOTENZA di `recordDecision`: una email
        // (il caso previsto, vedi il docblock del modulo) o — difensivamente,
        // per un jsonb malformato che indicizzasse un evento di calendario —
        // l'evento stesso. Nessuno dei due può mancare: `findSourceRow` ha già
        // stabilito da quale tabella viene `args.source`.
        const sourceKey =
          args.source.source === "email"
            ? `email:${args.source.gmailMessageId}`
            : `calendar:${args.source.googleEventId}`;
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
        await markSourceOutcome(tx, args.source, { status: "actioned", detail: { type: "decision_recorded" } });
        return { ok: true };
      }
      case "choose_project": {
        // Il worker non genera MAI questa azione per un evento di calendario
        // (`buildCalendarProposalEvent` propone solo `create_milestone` e
        // `ignore`): un jsonb che la persistisse lì sopra sarebbe
        // un'anomalia, non un `target_gone` — si lascia rientrare la
        // transazione con un'eccezione, che il chiamante marca `action_failed`.
        if (args.source.source !== "email") {
          throw new Error("choose_project non è prevista su una proposta da calendario");
        }
        const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, args.action.projectId));
        if (!project) return { ok: false, error: "target_gone" };
        // ⚠️ DEPRECATA in generazione dalla fase 6b (Task 5): il fan-out
        // ormai genera già una proposta per CIASCUN progetto del perimetro
        // del messaggio, quindi non serve più "spostare" un messaggio
        // ambiguo su un progetto — l'ambiguità che questa azione risolveva
        // non esiste più per le proposte nuove. Resta ESEGUIBILE solo per le
        // card pubblicate prima di questa fase (retro-compatibilità).
        //
        // Comportamento scelto per il caso storico (documentato: la review
        // potrebbe avere feedback, vedi il report del Task 6): si CHIUDE il
        // figlio corrente — quello del progetto ambiguo/sbagliato — con un
        // outcome che riflette la riassegnazione, esattamente come le altre
        // azioni terminali (`markSourceOutcome`, che tocca anche `updated_at`
        // del padre). Deliberatamente NON si sposta `email_proposals.project_id`
        // sul nuovo progetto: quel campo fa parte dell'unique
        // `(email_message_id, project_id)`, e se esistesse già un'altra riga
        // figlia per quella stessa coppia (il fan-out l'avrebbe già creata,
        // se il progetto scelto è nel perimetro) lo spostamento la
        // violerebbe — spostare introdurrebbe un caso di errore in più senza
        // guadagnare nulla, dato che la proposta per il progetto scelto o
        // esiste già (creata dal fan-out) o nascerà al prossimo giro di
        // classificazione, come riga a sé. E deliberatamente NON si tocca lo
        // stato del padre (`email_messages.status`) oltre a `updated_at`
        // (via `markSourceOutcome`): mai `status: 'new'` come faceva la
        // versione pre-6b, perché rimetterebbe l'INTERO messaggio in
        // classificazione, azzerando/sovrascrivendo le proposte sorelle
        // ancora aperte — esattamente ciò che questo task deve impedire.
        await markSourceOutcome(tx, args.source, {
          status: "actioned",
          detail: { type: "reassigned_project", projectId: args.action.projectId },
        });
        return { ok: true };
      }
      case "ignore": {
        await markSourceOutcome(tx, args.source, { status: "ignored", detail: { type: "ignored" } });
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

  // Validazione di MERITO dell'indice (400): è la richiesta del client a
  // essere fuori range, non il payload persistito a essere malato.
  const index = input.optionIndex;
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
