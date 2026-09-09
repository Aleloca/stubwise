import { randomUUID } from "node:crypto";
import {
  calendarEvents as calendarEventsTable,
  emailMessages,
  emailProposals,
  notifications,
  type Db,
  type EmailProposalRow,
} from "@stubwise/db";
import { t, type Language } from "@stubwise/i18n";
import { publishNotification, type GoogleProposalAction, type GoogleProposalEvent } from "@stubwise/notifications";
import { ticketPrioritySchema, ticketStatusSchema } from "@stubwise/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  buildMilestoneProposal,
  isReadyForProposal,
  isoDay,
  type CalendarMilestoneProposal,
  type CalendarSeriesProposalContext,
} from "./calendar.js";
import { EMAIL_PROPOSAL_TYPES, EMAIL_SIGNALS } from "./classify.js";

/**
 * FASE D (fase 6, Task 10; ripartita per progetto in fase 6b, Task 5): da una
 * riga già trattata — una proposta figlia `classified` (`email_proposals`,
 * UN progetto certo) o un evento di calendario pronto — alla **proposta** che
 * finisce nell'inbox del proprietario della casella.
 *
 * ## Due metà, e stanno insieme di proposito
 *
 * {@link buildEmailProposalEvent} e {@link buildCalendarProposalEvent} sono
 * PURE: da una riga (più la lingua e i nomi dei progetti) all'evento
 * `google.proposal`, senza toccare il database. {@link publishProposal} è
 * l'unica che scrive, e scrive DUE cose in una transazione sola: la notifica e
 * la chiusura della riga d'origine. Stanno nello stesso modulo perché sono un
 * contratto solo — l'evento che si costruisce è quello che si pubblica — e
 * separarle inviterebbe a costruirne uno e pubblicarne un altro.
 *
 * ## L'invariante: `actions[i]` è ciò che succede scegliendo `options[i]`
 *
 * È la stessa del pulse (`proposals[i] ↔ options[i]`) e si rompe allo stesso
 * modo: in silenzio, eseguendo l'azione sbagliata su una conferma data in buona
 * fede. Qui le due liste nascono **dallo stesso ciclo**, e
 * {@link googleProposalEventSchema} le riconta prima di ogni pubblicazione: un
 * evento disallineato non parte, invece di partire e sbagliare.
 *
 * ## Perché l'opzione «Non fare nulla» esiste come AZIONE
 *
 * Potrebbe sembrare l'assenza di azione, e invece è una variante
 * (`{ type: "ignore" }`) come tutte le altre. Se non lo fosse, l'ultima opzione
 * non avrebbe una `actions[i]` corrispondente e l'invariante di allineamento
 * salterebbe proprio sull'opzione che ogni proposta offre. È anche una
 * decisione vera — "questa email non diventa lavoro" — e come tale va
 * registrata, non fatta sparire.
 */

/** Opzioni ATTIVE al massimo su una proposta, esclusa «Non fare nulla». */
export const MAX_PROPOSAL_OPTIONS = 3;

/** Messaggi/eventi che diventano una proposta in un tick di una casella. */
export const DEFAULT_PROPOSE_MAX_PER_TICK = 20;

/**
 * Permalink al THREAD Gmail dentro la casella giusta.
 *
 * `/mail/u/<email>/` e non `/mail/u/0/`: l'indice numerico è la posizione
 * dell'account nel browser di CHI CLICCA, quindi `u/0` porta chiunque abbia più
 * account Google sulla casella sbagliata (e su un thread che lì non esiste).
 * Con l'indirizzo, Gmail sceglie l'account giusto o chiede di accedere.
 *
 * `#all/` e non `#inbox/`: un thread archiviato — che è la fine normale di una
 * email già trattata — sotto `#inbox` non si trova più.
 */
export function gmailThreadUrl(mailboxEmail: string, threadId: string): string {
  return `https://mail.google.com/mail/u/${encodeURIComponent(mailboxEmail)}/#all/${threadId}`;
}

/**
 * Link alla GIORNATA dell'appuntamento sul calendario della casella.
 *
 * NON è il permalink dell'evento, e la ragione è che non ce l'abbiamo:
 * `htmlLink` esiste nella risposta di `events.list` ma `calendar_events` non ha
 * una colonna dove tenerlo, e la proposta si pubblica leggendo la RIGA, non
 * l'evento appena scaricato. La vista giorno è il ripiego onesto: porta nel
 * punto esatto in cui l'appuntamento si vede, con un clic in più per aprirlo.
 * Chi un domani aggiungesse la colonna `html_link` cambi QUESTA funzione.
 */
export function calendarDayUrl(mailboxEmail: string, startsAt: Date): string {
  const [year, month, day] = isoDay(startsAt).split("-");
  return `https://calendar.google.com/calendar/u/${encodeURIComponent(mailboxEmail)}/r/day/${year}/${Number(month)}/${Number(day)}`;
}

/**
 * Lettura TOLLERANTE di UNA proposta rivalidata dal jsonb `classification`.
 *
 * Ricalca {@link RevalidatedProposal} di `./classify.ts` ma non lo importa come
 * schema: quel modulo lo espone come `interface`, e qui serve un validatore
 * runtime perché il jsonb può venire da una versione precedente del codice. I
 * cap non si ripetono: sono già stati applicati alla scrittura, e riapplicarli
 * qui butterebbe via una proposta buona solo perché il tetto è cambiato.
 */
const storedProposalSchema = z.object({
  type: z.enum(EMAIL_PROPOSAL_TYPES),
  consequence: z.string().min(1),
  projectId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  dueDate: z.string().min(1).optional(),
  ticketNumber: z.number().int().positive().optional(),
  ticketId: z.string().min(1).optional(),
  status: ticketStatusSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  decision: z.string().min(1).optional(),
});

type StoredProposal = z.infer<typeof storedProposalSchema>;

/**
 * Lettura tollerante dell'INTERA classificazione. `proposals` resta
 * `unknown[]`, come alla scrittura e per la stessa ragione: una proposta
 * marcia deve poter essere buttata da sola.
 */
const storedClassificationSchema = z.object({
  signal: z.enum(EMAIL_SIGNALS).catch("none"),
  proposals: z.array(z.unknown()).catch([]),
  recommendedIndex: z.number().int().min(0).catch(0),
});

/**
 * L'AZIONE dietro una proposta memorizzata, o `null` se le manca ciò che
 * serve a eseguirla.
 *
 * Il controllo è lo stesso dello `switch` finale di `revalidateProposal`, e
 * ripeterlo qui NON è una ridondanza inutile: là guardava l'output di un run,
 * qui guarda un jsonb riletto ore dopo. Un'azione senza referente non deve
 * comparire come opzione, perché confermarla non produrrebbe niente.
 */
export function actionForProposal(proposal: StoredProposal): GoogleProposalAction | null {
  switch (proposal.type) {
    case "create_backlog_item":
      if (!proposal.projectId || !proposal.title) return null;
      return {
        type: "create_backlog_item",
        projectId: proposal.projectId,
        title: proposal.title,
        ...(proposal.body ? { body: proposal.body } : {}),
      };
    case "create_milestone":
      if (!proposal.projectId || !proposal.name) return null;
      return {
        type: "create_milestone",
        projectId: proposal.projectId,
        name: proposal.name,
        ...(proposal.dueDate ? { dueDate: proposal.dueDate } : {}),
      };
    case "update_ticket":
      if (!proposal.ticketId || (!proposal.status && !proposal.priority)) return null;
      return {
        type: "update_ticket",
        ticketId: proposal.ticketId,
        ...(proposal.status ? { status: proposal.status } : {}),
        ...(proposal.priority ? { priority: proposal.priority } : {}),
      };
    case "comment_ticket":
      if (!proposal.ticketId || !proposal.body) return null;
      return { type: "comment_ticket", ticketId: proposal.ticketId, body: proposal.body };
    case "record_decision":
      if (!proposal.projectId || !proposal.title || !proposal.decision) return null;
      return {
        type: "record_decision",
        projectId: proposal.projectId,
        title: proposal.title,
        decision: proposal.decision,
        ...(proposal.ticketId ? { ticketId: proposal.ticketId } : {}),
      };
  }
}

/**
 * L'ETICHETTA dell'opzione: cosa la persona legge sul bottone.
 *
 * Viene da un TEMPLATE i18n interpolato con dati già rivalidati (il titolo che
 * il modello ha proposto, il numero di un ticket che esiste, il nome di una
 * milestone), non da una frase generata: la card deve dire cosa succede con le
 * stesse parole ogni volta. Del testo della card, il modello scrive solo la
 * `consequence` — che è la riga in cui una sfumatura serve davvero.
 */
function labelForProposal(lang: Language, proposal: StoredProposal): string {
  switch (proposal.type) {
    case "create_backlog_item":
      return t(lang, "email.proposal.createBacklogItem", { title: proposal.title ?? "" });
    case "create_milestone":
      return t(lang, "email.proposal.createMilestone", { name: proposal.name ?? "" });
    case "update_ticket":
      return t(lang, "email.proposal.updateTicket", { ticket: proposal.ticketNumber ?? 0 });
    case "comment_ticket":
      return t(lang, "email.proposal.commentTicket", { ticket: proposal.ticketNumber ?? 0 });
    case "record_decision":
      return t(lang, "email.proposal.recordDecision", { title: proposal.title ?? "" });
  }
}

/** Una opzione con la sua azione: nascono e viaggiano insieme, mai separate. */
interface OptionWithAction {
  label: string;
  consequence?: string;
  action: GoogleProposalAction;
}

/** L'ultima opzione di OGNI proposta: non dare seguito è una risposta. */
function ignoreOption(lang: Language): OptionWithAction {
  return {
    label: t(lang, "email.proposal.ignore"),
    consequence: t(lang, "email.proposal.ignoreConsequence"),
    action: { type: "ignore" },
  };
}

/** Assembla l'evento dalle opzioni già decise: l'unico punto che le allinea. */
function assembleEvent(args: {
  proposalId: string;
  source: "email" | "calendar";
  messageUrl: string;
  projectId?: string;
  projectName?: string;
  signal: GoogleProposalEvent["signal"];
  from: string;
  subject: string;
  receivedAt?: Date | null;
  question: string;
  options: OptionWithAction[];
  recommendedIndex: number;
  /** Fase 7b: `true` per una serie `auto: true` — l'azione è già eseguita. */
  auto?: boolean;
}): GoogleProposalEvent {
  return {
    kind: "google.proposal",
    proposalId: args.proposalId,
    source: args.source,
    messageUrl: args.messageUrl,
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.projectName ? { projectName: args.projectName } : {}),
    signal: args.signal,
    from: args.from,
    subject: args.subject,
    ...(args.receivedAt ? { receivedAt: args.receivedAt.toISOString() } : {}),
    question: args.question,
    options: args.options.map((option) => ({
      label: option.label,
      ...(option.consequence ? { consequence: option.consequence } : {}),
    })),
    actions: args.options.map((option) => option.action),
    recommendedIndex: args.recommendedIndex,
    allowFreeText: false,
    ...(args.auto ? { auto: true } : {}),
  };
}

/**
 * Il minimo del PADRE (`email_messages`) che serve a comporre una proposta:
 * mittente, oggetto, thread, data — comuni a OGNI figlio dello stesso
 * messaggio (fase 6b). Non porta più `projectId`/`candidateProjectIds`: il
 * progetto della proposta lo dice la riga figlia, non il messaggio.
 */
export interface EmailProposalMessageRow {
  threadId: string;
  fromAddress: string;
  fromName: string | null;
  subject: string | null;
  receivedAt: Date;
}

export interface BuildEmailProposalArgs {
  lang: Language;
  /** Il messaggio PADRE: mittente, oggetto, thread, data. */
  message: EmailProposalMessageRow;
  /**
   * La riga FIGLIA (`email_proposals`, fase 6b): il progetto è CERTO, non più
   * da risolvere qui. Bastano `projectId` e `classification`; gli altri campi
   * della riga (stato, esito…) non servono alla costruzione pura dell'evento.
   */
  proposal: Pick<EmailProposalRow, "projectId" | "classification">;
  /** Indirizzo della casella: entra nel permalink Gmail (vedi {@link gmailThreadUrl}). */
  mailboxEmail: string;
  /** Nome di ogni progetto nominabile, per id — qui serve solo quello del figlio. */
  projectNames: Map<string, string>;
  /** UUID della proposta. Iniettabile: è l'ancora, e i test devono poterla fissare. */
  proposalId?: string;
}

/**
 * L'evento `google.proposal` di UNA proposta figlia (`email_proposals`, fase
 * 6b — un progetto, un messaggio), o `null` se non c'è niente da proporre.
 *
 * `null` non è un errore: una classificazione da cui non sopravvive nessuna
 * azione produrrebbe una card con la sola opzione «Non fare nulla», cioè una
 * notifica che chiede di archiviare qualcosa che nessuno ha chiesto di aprire.
 * È `null` anche quando il nome del progetto non si risolve (`projectNames`
 * non lo contiene): senza un nome la domanda non può nominarlo, e la card
 * sarebbe indistinguibile dalle sorelle sullo stesso messaggio.
 *
 * ## `recommendedIndex` viene RIMAPPATO, non copiato
 *
 * L'indice memorizzato punta alle proposte com'erano alla classificazione; qui
 * qualcuna può cadere (un referente perso in un jsonb vecchio) e il tetto di
 * {@link MAX_PROPOSAL_OPTIONS} può tagliarne altre. Copiarlo com'è
 * evidenzierebbe l'opzione sbagliata — o nessuna, se punta oltre la fine. Si
 * segue quindi la proposta consigliata mentre si filtra, e se non sopravvive si
 * ricade su `0`: la prima è comunque quella che il modello ha messo per prima.
 *
 * ## `choose_project` NON si genera più
 *
 * Prima della fase 6b, un messaggio in perimetro ma AMBIGUO (parità di
 * regole, nessun progetto risolto, più candidati) offriva un'opzione
 * «Riguarda …» per candidato. Dalla fase 6b l'ambiguità non esiste più a
 * questo livello: il FAN-OUT (`classify.ts`/`writeClassification`) crea una
 * riga figlia per OGNI progetto del perimetro che ha prodotto almeno una
 * proposta valida, quindi il progetto di QUESTA proposta è già certo — è
 * `proposal.projectId`, non qualcosa da chiedere. `choose_project` resta
 * un'azione valida nell'unione (`@stubwise/notifications`) e nell'esecutore,
 * ma solo per le card pubblicate PRIMA di questa fase: vedi il commento di
 * deprecazione sul tipo.
 *
 * ⚠️ Fase 6c (Task 5): `choose_project` torna a essere GENERATA — ma non qui.
 * {@link buildTriageProposalEvent}, subito sotto, la genera per un caso
 * DIVERSO: un messaggio PADRE senza NESSUN figlio (nessun progetto
 * attribuibile, non "più d'uno ambiguo" come nel caso pre-6b sopra). Le due
 * proposte non si confondono — questa funzione resta per i figli, quella per
 * il padre — e la stessa azione ha due ESITI diversi a seconda di dove viene
 * confermata: vedi il commento sopra il case `"choose_project"` in
 * `apps/server/src/services/google-proposal.ts`.
 */
export function buildEmailProposalEvent(args: BuildEmailProposalArgs): GoogleProposalEvent | null {
  const { lang, message, proposal } = args;
  const parsed = storedClassificationSchema.safeParse(proposal.classification ?? {});
  if (!parsed.success) return null;
  const stored = parsed.data;

  const projectName = args.projectNames.get(proposal.projectId);
  if (!projectName) return null;

  const options: OptionWithAction[] = [];
  let recommendedIndex = 0;
  for (const [index, raw] of stored.proposals.entries()) {
    if (options.length >= MAX_PROPOSAL_OPTIONS) break;
    const parsedProposal = storedProposalSchema.safeParse(raw);
    if (!parsedProposal.success) continue;
    const action = actionForProposal(parsedProposal.data);
    if (!action) continue;
    if (index === stored.recommendedIndex) recommendedIndex = options.length;
    options.push({
      label: labelForProposal(lang, parsedProposal.data),
      consequence: parsedProposal.data.consequence,
      action,
    });
  }

  if (options.length === 0) return null;
  if (recommendedIndex >= options.length) recommendedIndex = 0;

  const from = message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress;
  const subject = message.subject?.trim() || t(lang, "email.input.none");

  return assembleEvent({
    proposalId: args.proposalId ?? randomUUID(),
    source: "email",
    messageUrl: gmailThreadUrl(args.mailboxEmail, message.threadId),
    projectId: proposal.projectId,
    projectName,
    signal: stored.signal,
    from,
    subject,
    receivedAt: message.receivedAt,
    // Il progetto è SEMPRE certo qui (riga figlia): sempre il template che lo
    // nomina, mai `email.proposal.question` (quello resta per rileggere le
    // card storiche, non per costruirne di nuove).
    question: t(lang, "google.proposal.question.withProject", { project: projectName, from, subject }),
    options: [...options, ignoreOption(lang)],
    recommendedIndex,
  });
}

/**
 * Lettura TOLLERANTE della classificazione «da smistare» del padre (fase 6c,
 * `classify.ts`, {@link EmailTriageClassification}) — stessa ragione di
 * {@link storedClassificationSchema}: un jsonb scritto da una versione
 * precedente del codice non deve far esplodere questa lettura, deve solo
 * produrre un evento più povero (o `null`, vedi {@link buildTriageProposalEvent}).
 */
const storedTriageClassificationSchema = z.object({
  triage: z.literal(true),
  signal: z.enum(EMAIL_SIGNALS).catch("none"),
  summary: z.string().catch(""),
  suggestedProjectIds: z.array(z.string()).catch([]),
});

/**
 * L'ultima opzione della proposta di SMISTAMENTO: «Nessuno di questi». Non è
 * la stessa {@link ignoreOption} delle altre proposte — stessa AZIONE
 * (`{ type: "ignore" }`, nessun payload nuovo da inventare) ma un'etichetta e
 * una conseguenza DIVERSE, perché qui "non fare nulla" significa "smistato e
 * scartato" (nessuno dei progetti suggeriti è quello giusto), non "va bene
 * così com'è" — vedi `apps/server/src/services/google-proposal.ts`, il ramo
 * `email_triage` di `markSourceOutcome`, per l'esito che questo distinguo
 * abilita in lettura.
 */
function triageIgnoreOption(lang: Language): OptionWithAction {
  return {
    label: t(lang, "email.proposal.triageIgnore"),
    consequence: t(lang, "email.proposal.triageIgnoreConsequence"),
    action: { type: "ignore" },
  };
}

/**
 * Il minimo del PADRE (`email_messages`) in stato «da smistare» che serve a
 * comporre la proposta di smistamento: stessi campi comuni di
 * {@link EmailProposalMessageRow} (mittente, oggetto, thread, data) più la
 * SUA `classification` — qui nella forma {@link EmailTriageClassification},
 * non quella con `proposals[]` delle proposte figlie.
 */
export interface TriageProposalMessageRow extends EmailProposalMessageRow {
  classification: Record<string, unknown> | null;
}

export interface BuildTriageProposalArgs {
  lang: Language;
  /** Il messaggio PADRE «da smistare»: nessun figlio, per costruzione. */
  message: TriageProposalMessageRow;
  mailboxEmail: string;
  /** Nome di ogni progetto SUGGERITO nominabile, per id. */
  projectNames: Map<string, string>;
  proposalId?: string;
}

/**
 * L'evento `google.proposal` DELLA PROPOSTA DI SMISTAMENTO (fase 6c, Task 5):
 * un segnale reale ma NESSUN progetto attribuito con successo — il TERZO
 * esito del design (§4), gemello di {@link buildEmailProposalEvent} ma per il
 * caso opposto: lì il progetto è certo e le azioni sono quelle proposte dal
 * modello; qui il progetto è esattamente ciò che MANCA, e le uniche azioni
 * possibili sono «di quale progetto si tratta» (`choose_project`, una per
 * progetto suggerito) e «nessuno di questi» (`ignore`).
 *
 * Vive sul PADRE — non c'è nessun figlio da cui costruirla, per costruzione
 * (`classify.ts`/`writeClassification` non ne crea in questo ramo) — quindi
 * NON porta `projectId`/`projectName` nell'evento: a differenza di
 * {@link buildEmailProposalEvent}, dove il progetto è già certo, qui non c'è
 * niente da nominare finché qualcuno non sceglie.
 *
 * `null` solo quando la classificazione persistita non regge la validazione
 * (jsonb malformato: il padre resta `classified` e il tick successivo
 * riprova) — MAI quando `suggestedProjectIds` è vuoto: un elenco vuoto è
 * legittimo (il modello non ha nominato nessun progetto specifico) e la card
 * nasce comunque, con la sola opzione «Nessuno di questi». Un progetto
 * suggerito il cui nome non si risolve più (cancellato fra la
 * classificazione e la pubblicazione) si salta SENZA invalidare l'intero
 * evento — le altre opzioni restano valide, esattamente come
 * {@link buildEmailProposalEvent} salta una singola proposta il cui nome di
 * progetto non si risolve.
 */
export function buildTriageProposalEvent(args: BuildTriageProposalArgs): GoogleProposalEvent | null {
  const { lang, message } = args;
  const parsed = storedTriageClassificationSchema.safeParse(message.classification ?? {});
  if (!parsed.success) return null;
  const stored = parsed.data;

  const options: OptionWithAction[] = [];
  for (const projectId of stored.suggestedProjectIds) {
    if (options.length >= MAX_PROPOSAL_OPTIONS) break;
    const projectName = args.projectNames.get(projectId);
    if (!projectName) continue;
    options.push({
      label: t(lang, "email.proposal.chooseProject", { project: projectName }),
      consequence: t(lang, "email.proposal.chooseProjectConsequence", { project: projectName }),
      action: { type: "choose_project", projectId },
    });
  }

  const from = message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress;
  const subject = message.subject?.trim() || t(lang, "email.input.none");

  return assembleEvent({
    proposalId: args.proposalId ?? randomUUID(),
    source: "email",
    messageUrl: gmailThreadUrl(args.mailboxEmail, message.threadId),
    // NIENTE projectId/projectName: qui il progetto è ciò che manca, non un
    // dato già certo (a differenza di buildEmailProposalEvent).
    signal: stored.signal,
    from,
    subject,
    receivedAt: message.receivedAt,
    question: t(lang, "google.proposal.question.triage", { from, subject }),
    options: [...options, triageIgnoreOption(lang)],
    recommendedIndex: 0,
  });
}

/** Il minimo di `calendar_events` che serve a comporre una proposta. */
export interface CalendarProposalRow {
  id: string;
  title: string | null;
  startsAt: Date;
  organizer: string | null;
  status: string | null;
  projectId: string | null;
  proposalNotificationId: string | null;
  outcome: Record<string, unknown> | null;
  /** Fase 7b: `null` per un evento singolo, l'id della serie altrimenti. */
  recurringEventId: string | null;
}

export interface BuildCalendarProposalArgs {
  lang: Language;
  event: CalendarProposalRow;
  mailboxEmail: string;
  projectNames: Map<string, string>;
  proposalId?: string;
  /**
   * Fase 7b: il contesto di serie per il cancello di {@link isReadyForProposal}
   * — SOLO per un'occorrenza di serie (`event.recurringEventId !== null`),
   * ignorato altrimenti. Assente = trattata come serie non configurata
   * (spenta): un chiamante che dimentica di passarlo per un'occorrenza di
   * serie ottiene `null` qui, non una proposta silenziosamente sbagliata.
   */
  seriesContext?: CalendarSeriesProposalContext;
}

/**
 * L'evento `google.proposal` di UN appuntamento pronto, o `null`.
 *
 * Nessuna AI e nessuna scelta: una sola opzione — la milestone che
 * {@link buildMilestoneProposal} compone, che è l'unica definizione di «che
 * proposta farebbe questo evento» — più «Non fare nulla», e la consigliata è
 * per forza la prima. Il segnale è sempre `deadline`, perché è esattamente ciò
 * che un appuntamento è.
 *
 * Il cancello resta {@link isReadyForProposal}, riapplicato qui e non solo
 * nella `where` di chi legge: è il contratto fra la fase 3 e questa, e un
 * chiamante nuovo non deve poterlo aggirare scrivendosi una query sua.
 */
/**
 * L'UNICA opzione di una proposta di calendario, secondo l'azione configurata
 * sulla serie (design fase 7b §4). Un evento SINGOLO (nessuna serie) non ha
 * mai un'azione diversa da `"milestone"`: è il comportamento storico,
 * invariato — {@link buildCalendarProposalEvent} lo passa di default.
 */
function calendarPrimaryOption(
  lang: Language,
  seriesAction: "backlog_item" | "milestone" | "reminder",
  args: { projectId: string; projectName: string; milestone: CalendarMilestoneProposal },
): OptionWithAction {
  const { projectId, projectName, milestone } = args;
  if (seriesAction === "backlog_item") {
    return {
      label: t(lang, "email.proposal.createBacklogItem", { title: milestone.name }),
      consequence: t(lang, "email.proposal.calendarBacklogConsequence", { project: projectName }),
      action: { type: "create_backlog_item", projectId, title: milestone.name },
    };
  }
  if (seriesAction === "reminder") {
    return {
      label: t(lang, "email.proposal.calendarReminder"),
      consequence: t(lang, "email.proposal.calendarReminderConsequence"),
      action: { type: "acknowledge_reminder" },
    };
  }
  return {
    label: t(lang, "email.proposal.createMilestone", { name: milestone.name }),
    consequence: t(lang, "email.proposal.calendarConsequence", { date: milestone.dueDate, project: projectName }),
    action: { type: "create_milestone", projectId, name: milestone.name, dueDate: milestone.dueDate },
  };
}

export function buildCalendarProposalEvent(
  args: BuildCalendarProposalArgs,
): GoogleProposalEvent | null {
  const { lang, event } = args;
  if (!isReadyForProposal(event, args.seriesContext)) return null;
  const milestone = buildMilestoneProposal(lang, event);
  if (!milestone) return null;
  // `isReadyForProposal` garantisce già che ci sia; la const lo dice anche al
  // compilatore, che quel cancello non lo sa leggere.
  const projectId = event.projectId;
  if (!projectId) return null;
  const projectName = args.projectNames.get(projectId);
  if (!projectName) return null;

  // Fase 7b (Task 5): un evento SINGOLO (nessuna serie, `seriesContext`
  // assente) resta sul comportamento storico — sempre "milestone". Solo
  // un'occorrenza di serie CONFIGURATA sceglie l'azione: a questo punto
  // `isReadyForProposal` garantisce già che la serie sia accesa, quindi
  // `series` non è `null`.
  const series = args.seriesContext?.series;
  const seriesAction = series?.action ?? "milestone";
  const auto = series?.auto ?? false;

  const subject = (event.title ?? "").trim();
  return assembleEvent({
    proposalId: args.proposalId ?? randomUUID(),
    source: "calendar",
    messageUrl: calendarDayUrl(args.mailboxEmail, event.startsAt),
    projectId,
    projectName,
    signal: "deadline",
    from: event.organizer ?? args.mailboxEmail,
    subject,
    receivedAt: event.startsAt,
    // Fase 7b: se la serie è `auto`, l'azione è GIÀ eseguita (il chiamante la
    // esegue subito dopo la publish, vedi il poller) — la card lo AFFERMA,
    // non lo chiede.
    question: auto
      ? t(lang, "email.proposal.calendarAutoQuestion", { subject, date: milestone.dueDate })
      : t(lang, "email.proposal.calendarQuestion", { subject, date: milestone.dueDate }),
    options: [calendarPrimaryOption(lang, seriesAction, { projectId, projectName, milestone }), ignoreOption(lang)],
    recommendedIndex: 0,
    auto,
  });
}

/**
 * L'ULTIMO CANCELLO prima della pubblicazione.
 *
 * Non ripete la validazione di ogni campo (l'evento lo costruiamo noi, non
 * arriva da fuori): controlla le poche cose che, sbagliate, produrrebbero una
 * card DANNOSA invece di una card rotta — l'allineamento fra opzioni e azioni,
 * l'indice consigliato dentro il range, l'ancora presente. Un evento che non
 * passa non viene pubblicato e la riga d'origine resta dov'è, quindi il tick
 * successivo riprova.
 */
export const googleProposalEventSchema = z
  .object({
    kind: z.literal("google.proposal"),
    proposalId: z.uuid(),
    options: z.array(z.object({ label: z.string().min(1) })).min(1),
    actions: z.array(z.object({ type: z.string().min(1) })).min(1),
    recommendedIndex: z.number().int().min(0).optional(),
  })
  .loose()
  .refine((event) => event.options.length === event.actions.length, {
    message: "options e actions devono avere la stessa lunghezza",
  })
  .refine(
    (event) => event.recommendedIndex === undefined || event.recommendedIndex < event.options.length,
    { message: "recommendedIndex fuori dalle opzioni" },
  );

/** Firma della publish iniettabile (default: `publishNotification`). */
export type PublishFn = typeof publishNotification;

export interface PublishProposalArgs {
  event: GoogleProposalEvent;
  /**
   * Quale RIGA D'ORIGINE chiudere dopo la publish — NON "che tipo di evento
   * è" (quello lo dice `event.source`, sempre `"email" | "calendar"`, anche
   * per una proposta di smistamento: nasce comunque da un'email). Fase 6c:
   * `"email_triage"` è un TERZO caso — la proposta di smistamento (Task 5),
   * dove il claim avviene sul PADRE (`email_messages`), non su un figlio: non
   * ce n'è nessuno, per costruzione (`classify.ts`/`writeClassification`).
   */
  source: "email" | "calendar" | "email_triage";
  /**
   * `email_proposals.id` per `"email"` (la riga FIGLIA, fase 6b — non più
   * `email_messages.id`: il padre non si claima più qui in QUESTO caso, vedi
   * il docblock della funzione), `calendar_events.id` per `"calendar"`, o
   * `email_messages.id` (il PADRE stesso) per `"email_triage"`.
   */
  rowId: string;
  /** L'UNICO destinatario: `google_accounts.user_id` (audience `mailbox_owner`). */
  mailboxOwnerUserId: string;
  /** Progetto della notifica, quando risolto. */
  projectId?: string;
  publish?: PublishFn;
}

/**
 * Perché una proposta NON è stata pubblicata.
 *
 * `invalid_event` — non ha passato {@link googleProposalEventSchema};
 * `not_claimable` — la riga non è più proponibile (un altro tick, o un altro
 * worker, è arrivato prima); `no_recipients` — nessuno a cui mandarla
 * (proprietario cancellato, o `publish` fallita: è best-effort e torna 0 in
 * entrambi i casi); `notification_missing` — la riga di inbox non si è
 * ritrovata, cioè qualcosa di davvero anomalo.
 */
export type PublishProposalFailure =
  | "invalid_event"
  | "not_claimable"
  | "no_recipients"
  | "notification_missing";

export type PublishProposalResult =
  | { ok: true; notificationId: string; published: number }
  | { ok: false; reason: PublishProposalFailure };

/** Sentinella per far rientrare la transazione senza inventarsi un errore vero. */
class ProposalAborted extends Error {
  constructor(readonly reason: PublishProposalFailure) {
    super(reason);
    this.name = "ProposalAborted";
  }
}

/**
 * Pubblica la proposta E chiude la riga d'origine, **nella stessa
 * transazione**.
 *
 * ## Perché insieme, e in quest'ordine
 *
 * Le due scritture sono una sola cosa: una notifica senza la riga marcata
 * verrebbe ripubblicata a ogni tick (una card nuova ogni cinque minuti sulla
 * stessa email); una riga marcata senza notifica sarebbe una proposta che non
 * esiste, e nessun poller la ripescherebbe più. Dentro una transazione, un
 * crash a metà non lascia né l'una né l'altra.
 *
 * L'ordine è: **pubblica, ritrova l'id, poi CHIUDI la riga con una `where`
 * guardata**. Non è indifferente. Il claim deve essere l'ULTIMA scrittura
 * perché è l'unica che può dire «ha vinto un altro»: due worker che pubblicano
 * insieme si serializzano sul lock di riga della sorgente, il secondo rilegge
 * la condizione, non trova più niente da aggiornare e fa rientrare tutto — la
 * sua notifica compresa. Se il claim venisse prima, il perdente dovrebbe
 * comunque rientrare, ma avremmo pagato una publish per scoprirlo dopo aver già
 * deciso di vincere.
 *
 * L'id della notifica si RITROVA (`event->>'proposalId'`) invece di farselo
 * restituire: `publishNotification` torna solo quanti destinatari ha raggiunto,
 * e allargarne il contratto per un solo chiamante costerebbe più di questa
 * query — che è esatta perché l'audience `mailbox_owner` scrive una riga sola.
 *
 * ## Fase 6b: il claim è sulla riga FIGLIA, mai sul padre — per `source: "email"`
 *
 * Per `source: "email"` il claim guardato è su `email_proposals` (l'indice
 * parziale `email_proposals_claim_idx`, `WHERE status='classified' AND
 * proposal_notification_id IS NULL`), non più su `email_messages`. Questa
 * funzione NON TOCCA MAI `email_messages` in questo ramo: lo stato aggregato
 * del padre si calcola in LETTURA altrove (Task 6/8), non si persiste qui. È
 * così che due proposte dello stesso messaggio — due figli, due progetti — si
 * pubblicano in parallelo (due chiamate concorrenti a questa funzione) senza
 * contendersi nessuna riga: ciascuna claima solo il proprio figlio.
 *
 * ## Fase 6c: `source: "email_triage"` claima il PADRE — non è un'eccezione,
 * è il caso per cui il padre NON ha nessun figlio
 *
 * La proposta di smistamento (Task 5) non ha una riga figlia da cui nascere
 * (`writeClassification` non ne crea per questo messaggio): il claim guardato
 * torna quindi a essere su `email_messages` — `WHERE status = 'classified'
 * AND proposal_notification_id IS NULL`, lo stesso pattern della fase 6
 * ORIGINALE, prima del fan-out — perché per QUESTO messaggio è la riga
 * d'origine vera, non un ripiego. Nessuna contesa possibile con la fase 6b
 * qui sopra: un messaggio con figli non è mai anche «da smistare» (i due
 * canali di selezione, nel poller, non si sovrappongono — vedi
 * `runProposePhase`).
 *
 * NON LANCIA per gli esiti previsti (li porta in `reason`); lascia salire solo
 * gli errori veri del database, che il chiamante tratta come tali.
 */
export async function publishProposal(
  db: Db,
  args: PublishProposalArgs,
): Promise<PublishProposalResult> {
  if (!googleProposalEventSchema.safeParse(args.event).success) {
    return { ok: false, reason: "invalid_event" };
  }
  const publish = args.publish ?? publishNotification;

  try {
    return await db.transaction(async (tx) => {
      const { published } = await publish(tx, args.event, {
        mailboxOwnerUserId: args.mailboxOwnerUserId,
        ...(args.projectId ? { projectId: args.projectId } : {}),
      });
      if (published === 0) throw new ProposalAborted("no_recipients");

      const [row] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.kind, "google.proposal"),
            sql`${notifications.event}->>'proposalId' = ${args.event.proposalId}`,
          ),
        )
        .limit(1);
      if (!row) throw new ProposalAborted("notification_missing");

      const claimed =
        args.source === "email"
          ? await tx
              .update(emailProposals)
              .set({ status: "proposed", proposalNotificationId: row.id })
              .where(
                and(
                  eq(emailProposals.id, args.rowId),
                  eq(emailProposals.status, "classified"),
                  isNull(emailProposals.proposalNotificationId),
                ),
              )
              .returning({ id: emailProposals.id })
          : args.source === "email_triage"
            ? await tx
                .update(emailMessages)
                .set({ status: "proposed", proposalNotificationId: row.id })
                .where(
                  and(
                    eq(emailMessages.id, args.rowId),
                    eq(emailMessages.status, "classified"),
                    isNull(emailMessages.proposalNotificationId),
                  ),
                )
                .returning({ id: emailMessages.id })
            : await tx
                .update(calendarEventsTable)
                .set({ proposalNotificationId: row.id })
                .where(
                  and(
                    eq(calendarEventsTable.id, args.rowId),
                    isNull(calendarEventsTable.proposalNotificationId),
                    isNull(calendarEventsTable.outcome),
                  ),
                )
                .returning({ id: calendarEventsTable.id });
      if (claimed.length === 0) throw new ProposalAborted("not_claimable");

      return { ok: true as const, notificationId: row.id, published };
    });
  } catch (err) {
    if (err instanceof ProposalAborted) return { ok: false, reason: err.reason };
    throw err;
  }
}
