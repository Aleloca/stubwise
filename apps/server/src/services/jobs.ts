/**
 * Servizio dei job AI: unica fonte di verità su chi può lanciare un run, su
 * come un run nasce (o riprende) e su cosa succede quando un piano viene
 * approvato o rifiutato. Le rotte HTTP ci passano attraverso invece di scrivere
 * `ai_jobs` a mano, così ogni superficie (oggi `/api/tickets/:id/run-ai` e le
 * due di approvazione) applica le stesse regole.
 *
 * Modello dei ruoli (Fase 0), sull'enum globale `user_role`:
 *  - `admin`  = MAINTAINER: approva i piani e può far partire il fix diretto;
 *  - `member` = OPERATOR: propone il lavoro, ma non lo approva. Ogni run che
 *    chiede si ferma sul gate del piano prima di toccare il codice.
 */
import { aiJobs, comments, projects, tickets, type Db } from "@stubwise/db";
import { t } from "@stubwise/i18n";
import { IN_FLIGHT_JOB_STATUSES, publishNotification } from "@stubwise/notifications";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { ticketUrl } from "../ingest/shared.js";
import { getContentLanguage } from "../settings.js";
import { propagateDecision } from "./notifications-propagation.js";

/** Chi chiede l'azione: `id` per l'audit sul job, `role` per i permessi. */
export type Actor = { id: string; role: "admin" | "member" };

/**
 * Stati in cui un job è VIVO: in coda, in lavorazione dal worker, o fermo su un
 * piano che aspetta una risposta. Rilanciare su uno di questi significherebbe
 * scippare il lavoro in corso (il worker che lo sta eseguendo perderebbe la
 * ownership a metà), perciò `startRun` rifiuta con `job_in_flight` invece di
 * riscrivere la riga come faceva la vecchia rotta.
 *
 * La lista vive in `@stubwise/notifications` (`actions.ts`), dove serve anche a
 * decidere se una notifica può offrire il `relaunch`: qui viene RI-ESPORTATA
 * col suo nome storico, così le due non possono divergere.
 */
export const IN_FLIGHT = IN_FLIGHT_JOB_STATUSES;

export type StartRunResult =
  | { ok: true; jobId: string; status: "queued" | "awaiting_plan_approval" }
  | { ok: false; error: "ticket_not_found" | "job_in_flight"; jobStatus?: string };

export interface StartRunInput {
  ticketId: string;
  actor: Actor;
  /**
   * `"ai_plan"` forza il flusso normale (triage + pianificazione) anche se il
   * ticket ha già un piano salvato: è l'unico valore ammesso.
   */
  mode?: "ai_plan";
  /**
   * Rilancio "con istruzioni": salta il triage e riparte dal fix, che rilegge i
   * commenti del team lasciati sul ticket. Perde contro il piano salvato.
   */
  withInstructions?: boolean;
  /**
   * URL pubblico dell'istanza (PUBLIC_URL), per il link al ticket nella
   * notifica `job.plan_review` del ramo parcheggiato. Assente = il link è il
   * solo path (stessa convenzione di `ingest/shared.ts`). Il servizio non
   * conosce fastify: la rotta glielo passa con `publicUrlOrUndefined(app)`.
   */
  publicUrl?: string;
  /**
   * Forza il gate del piano ANCHE per un maintainer: `planApprovalRequired`
   * acceso e, col piano salvato, parcheggio diretto in `awaiting_plan_approval`
   * invece della partenza in execute. Serve ai run che nascono da un
   * suggerimento del sistema (il "Procedi con X" del pulse, fase 2): chi clicca
   * accetta una proposta, non ha letto un piano — quindi nulla si esegue prima
   * che qualcuno lo approvi davvero. Assente/false = comportamento invariato
   * (solo un `member` passa dal gate).
   */
  requirePlanApproval?: boolean;
}

/**
 * Avvia (o rilancia) il run AI di un ticket. Riusa l'ultimo job del ticket se
 * è concluso, altrimenti ne crea uno nuovo; se invece è ancora in volo non
 * tocca nulla e ritorna `job_in_flight`.
 *
 * ESECUZIONE DIRETTA DAL PIANO SALVATO: con `implementationPlan` sul ticket e
 * senza `mode:"ai_plan"`, il job parte in execute-diretta (`resumeMode`
 * `"execute"`, `planText` = piano): il worker salta triage e pianificazione.
 * Il piano salvato ha la precedenza su `withInstructions` — è la scelta più
 * forte, c'è già un piano da eseguire.
 *
 * GATE DEL PIANO PER GLI OPERATOR: un `member` non può far partire codice senza
 * che un maintainer abbia approvato. Se ha un piano salvato il job nasce già
 * `awaiting_plan_approval` (stesso stato che il worker produce con
 * `parkForPlanApproval`); se non ce l'ha parte `queued` con
 * `planApprovalRequired`, così il worker si fermerà a piano pronto (gate letto
 * dal worker in `resolveFixMode`: Task 3 della fase 0).
 *
 * `requirePlanApproval` estende lo stesso gate a un attore qualsiasi (anche un
 * maintainer): è il guardrail dei run che nascono da una proposta del sistema.
 *
 * Nel ramo che parcheggia subito (gate + piano salvato) è QUESTA funzione a
 * pubblicare `job.plan_review`: è l'unico `awaiting_plan_approval` che non nasce
 * dal worker, e senza la notifica la richiesta di approvazione resterebbe muta.
 *
 * Tutta la decisione (lettura dell'ultimo job + UPDATE o INSERT) sta in una
 * transazione aperta da un lock advisory sul ticket: due rilanci concorrenti si
 * serializzano, così il secondo VEDE il job appena accodato dal primo e risponde
 * `job_in_flight` invece di accodarne un altro.
 */
export async function startRun(db: Db, input: StartRunInput): Promise<StartRunResult> {
  const { ticketId, actor } = input;
  const [ticket] = await db
    .select({
      id: tickets.id,
      implementationPlan: tickets.implementationPlan,
      // Il resto serve alla notifica del ramo parcheggiato (vedi in fondo).
      number: tickets.number,
      title: tickets.title,
      projectId: tickets.projectId,
      projectName: projects.name,
    })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .where(eq(tickets.id, ticketId));
  if (!ticket) return { ok: false, error: "ticket_not_found" };

  const useSavedPlan = ticket.implementationPlan !== null && input.mode !== "ai_plan";
  // resumeMode: "execute" col piano salvato; altrimenti "fix" se withInstructions
  // (riparte dal fix scavalcando il triage), else null (si rifà il triage).
  const resumeMode = useSavedPlan ? "execute" : input.withInstructions ? "fix" : null;
  // planText: il piano salvato in esecuzione diretta, altrimenti azzerato (un
  // piano residuo di un run precedente non deve sopravvivere al re-triage).
  const planText = useSavedPlan ? ticket.implementationPlan : null;

  // Passa dal gate chi non può approvare da sé (operator) e chiunque, ruolo a
  // parte, avvii un run che il chiamante ha marcato come da approvare
  // (`requirePlanApproval`).
  const needsApproval = actor.role === "member" || input.requirePlanApproval === true;
  const status = needsApproval && useSavedPlan ? "awaiting_plan_approval" : "queued";
  const values = {
    status,
    manualTrigger: true,
    resumeMode,
    planText,
    requestedByUserId: actor.id,
    // Acceso per TUTTI i run che passano dal gate, anche quello già
    // parcheggiato: se il maintainer rifiuta il piano, la ripianificazione
    // dovrà fermarsi di nuovo sul gate.
    planApprovalRequired: needsApproval,
  } as const;

  const result = await db.transaction(async (tx): Promise<StartRunResult> => {
    // Lock advisory di transazione sul ticket (stesso pattern del setup admin
    // in routes/auth.ts): serializza i rilanci concorrenti SULLO STESSO ticket
    // e si rilascia da solo al commit. Senza, due richieste su un ticket senza
    // job leggerebbero entrambe "nessun job" e ne accoderebbero due.
    // Un'eventuale collisione di hashtext serializza due ticket diversi:
    // innocuo, il lock si tiene per pochi millisecondi.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ticketId}))`);

    // L'ultimo job del ticket (per createdAt, id come spareggio): è quello che
    // la timeline mostra in cima e che l'utente intende rilanciare.
    const [latest] = await tx
      .select({ id: aiJobs.id, status: aiJobs.status })
      .from(aiJobs)
      .where(eq(aiJobs.ticketId, ticketId))
      .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id))
      .limit(1);

    if (latest && isInFlight(latest.status)) {
      return { ok: false, error: "job_in_flight", jobStatus: latest.status };
    }

    if (latest) {
      // UPDATE guardato sugli stati NON in volo: il lock esclude gli altri
      // startRun, ma non chi tocca il job da fuori (il claim del worker o il
      // resume poller possono portare un `held` a `queued` proprio ora). In quel
      // caso 0 righe → si rilegge lo stato per rispondere il vero motivo.
      const updated = await tx
        .update(aiJobs)
        .set({
          ...values,
          startedAt: null,
          finishedAt: null,
          error: null,
          lastActivityAt: sql`now()`,
        })
        .where(and(eq(aiJobs.id, latest.id), notInArray(aiJobs.status, [...IN_FLIGHT])))
        .returning({ id: aiJobs.id });
      if (updated.length === 0) {
        const [current] = await tx
          .select({ status: aiJobs.status })
          .from(aiJobs)
          .where(eq(aiJobs.id, latest.id));
        return { ok: false, error: "job_in_flight", jobStatus: current?.status };
      }
      return { ok: true, jobId: latest.id, status };
    }

    const [created] = await tx
      .insert(aiJobs)
      .values({ ticketId, ...values })
      .returning({ id: aiJobs.id });
    return { ok: true, jobId: created!.id, status };
  });

  // Il ramo che parcheggia SUBITO il job (gate + piano salvato) è
  // l'unico punto in cui un `awaiting_plan_approval` nasce senza passare dal
  // worker: se non notificasse qui, la richiesta di approvazione resterebbe
  // muta (il worker emette `job.plan_review` solo quando pianifica lui).
  // Best-effort e FUORI transazione: l'esito della rotta non dipende dalla
  // notifica (publishNotification non lancia comunque mai).
  if (result.ok && result.status === "awaiting_plan_approval") {
    await publishNotification(
      db,
      {
        kind: "job.plan_review",
        ticketNumber: ticket.number,
        ticketTitle: ticket.title,
        projectName: ticket.projectName,
        ticketUrl: ticketUrl(input.publicUrl, ticket.id),
      },
      { projectId: ticket.projectId, ticketId: ticket.id, jobId: result.jobId },
    );
  }
  return result;
}

export type ResolvePlanResult =
  | {
      ok: true;
      jobId: string;
      /**
       * Righe d'inbox chiuse dalla decisione (le copie `job.plan_review` di
       * tutti i destinatari). Il loro rispecchiamento su Slack è GIÀ stato
       * accodato da qui: il chiamante non deve rifarlo, gli id servono solo a
       * riferire cos'è cambiato.
       */
      changedNotificationIds: string[];
    }
  | { ok: false; error: "ticket_not_found" | "plan_not_pending" | "forbidden" };

export interface ResolvePlanInput {
  ticketId: string;
  actor: Actor;
  /** `"execute"` approva (il piano si esegue), `"fix"` rifiuta (si ripianifica). */
  mode: "execute" | "fix";
  /**
   * Indicazioni con cui rilanciare la pianificazione: finiscono in un commento
   * `authorType: "user"` sul ticket, cioè esattamente dove il worker rilegge le
   * "indicazioni del team" per costruire il prompt di re-plan.
   */
  instructions?: string;
}

/**
 * Approva (`execute`) o rifiuta (`fix`) il piano fermo sul gate. Solo i
 * maintainer: è la decisione che sblocca la scrittura di codice.
 *
 * Verifica il ticket, individua l'ultimo job in `awaiting_plan_approval` e, in
 * una transazione, fa un UPDATE CONDIZIONATO a quello stato: se 0 righe →
 * `plan_not_pending` (idempotente contro doppi click e race). Altrimenti
 * inserisce nella stessa transazione le eventuali istruzioni del team e il
 * commento di sistema. `execute` conserva il piano, `fix` lo azzera.
 *
 * CHIUDE ANCHE L'INBOX. Decidere su un piano rende obsolete le notifiche
 * `job.plan_review` di TUTTI i destinatari, non solo di chi ha deciso e non solo
 * sulla superficie da cui ha deciso: la propagazione sta qui, nel servizio, così
 * la ottengono per costruzione la pagina ticket
 * (`POST /tickets/:id/approve-plan`), l'inbox e Slack. Finché è vissuta nelle
 * sole `executeAction` + handler Slack, una decisione presa dalla pagina ticket
 * lasciava le copie aperte e i DM con i bottoni di una scelta già fatta.
 */
export async function resolvePlan(db: Db, input: ResolvePlanInput): Promise<ResolvePlanResult> {
  const { ticketId, actor, mode } = input;
  if (actor.role !== "admin") return { ok: false, error: "forbidden" };

  const [ticket] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  if (!ticket) return { ok: false, error: "ticket_not_found" };

  // Si prende l'ultimo job IN STATO awaiting_plan_approval, non l'ultimo job in
  // assoluto: un job più recente in altro stato renderebbe altrimenti
  // irraggiungibile un piano genuinamente in attesa.
  const [latest] = await db
    .select({ id: aiJobs.id })
    .from(aiJobs)
    .where(and(eq(aiJobs.ticketId, ticketId), eq(aiJobs.status, "awaiting_plan_approval")))
    .orderBy(desc(aiJobs.createdAt), desc(aiJobs.id))
    .limit(1);
  if (!latest) return { ok: false, error: "plan_not_pending" };

  const lang = await getContentLanguage(db);
  const instructions = input.instructions?.trim();
  // planText: conservato in execute (è il piano approvato), azzerato in fix.
  const planTextUpdate = mode === "fix" ? { planText: null } : {};

  const resolved = await db.transaction(async (tx) => {
    const updated = await tx
      .update(aiJobs)
      .set({
        status: "queued",
        resumeMode: mode,
        ...planTextUpdate,
        startedAt: null,
        finishedAt: null,
        error: null,
        lastActivityAt: sql`now()`,
      })
      .where(and(eq(aiJobs.id, latest.id), eq(aiJobs.status, "awaiting_plan_approval")))
      .returning({ id: aiJobs.id });
    if (updated.length === 0) return null;

    // Le istruzioni PRIMA del commento di sistema: sono un contributo umano al
    // ticket, il commento di sistema è la nota di ciò che è appena successo.
    if (instructions) {
      await tx
        .insert(comments)
        .values({ ticketId, authorType: "user", authorId: actor.id, body: instructions });
    }
    await tx.insert(comments).values({
      ticketId,
      authorType: "system",
      body: t(lang, mode === "execute" ? "comment.planApproved" : "comment.planRejected"),
      // clock_timestamp() e non il default now(): dentro una transazione now()
      // è l'istante di INIZIO, identico per i due insert, e la timeline (che
      // ordina per createdAt) potrebbe mostrarli invertiti.
      createdAt: sql`clock_timestamp()`,
    });
    return updated[0]!;
  });

  if (!resolved) return { ok: false, error: "plan_not_pending" };

  // FUORI dalla transazione, come la `publishNotification` di `startRun`: la
  // decisione è presa e scritta, e nulla di ciò che segue deve poterla
  // annullare. `propagateDecision` è best-effort sul rispecchiamento Slack; la
  // chiusura delle righe è un solo UPDATE guardato.
  const changedNotificationIds = await propagateDecision(db, {
    target: { jobId: resolved.id, kind: "job.plan_review" },
    action: mode === "execute" ? "approve_plan" : "reject_plan",
    actorId: actor.id,
  });
  return { ok: true, jobId: resolved.id, changedNotificationIds };
}

/** True se lo stato del job è uno di {@link IN_FLIGHT}. */
function isInFlight(status: string): boolean {
  return (IN_FLIGHT as readonly string[]).includes(status);
}
