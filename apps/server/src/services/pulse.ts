/**
 * "PROCEDI CON X": la proposta scelta su una notifica `project.pulse` diventa
 * un ticket e un run che si ferma sul gate del piano.
 *
 * È il gemello di `./questions.ts` sul lato pulse. La fase 1 ha stabilito la
 * disciplina — permessi e stato applicati dal servizio, UPDATE guardati,
 * errori tipizzati, propagazione FUORI dalla transazione perché Slack è I/O
 * esterno e best-effort — e qui la si ripete: `executeAction` dispatcha
 * `answer` all'uno o all'altro a seconda del `kind`, e nessuna delle due
 * superfici (inbox web, bottoni Slack) sa cosa succede dopo.
 *
 * PERCHÉ UN MODULO A PARTE e non dentro `./inbox.ts`: `./inbox.ts` importa
 * `./jobs.ts`, e questo servizio importa `./jobs.ts` (`startRun`) e
 * `./backlog.ts` — metterlo lì legherebbe il "Procedi" alla superficie inbox,
 * mentre domani ci arriveranno anche il terminale MCP o la pagina progetto. Qui
 * le dipendenze sono `db`, il catalogo dei permessi, il convert del backlog e i
 * job: nessuno può creare un ciclo importandolo.
 *
 * DUE TRANSAZIONI, E NON SI FINGONO ATOMICHE. `convertBacklogItem` e `startRun`
 * sono due scritture separate, di proposito: "voce convertita + ticket senza
 * run" è già uno stato di prima classe del sistema (la conversione per design
 * non accoda nulla, il ticket resta lanciabile a mano), su un ticket appena
 * creato la seconda può fallire solo per errori infrastrutturali, e legarle
 * insieme trascinerebbe dentro la transazione la `publishNotification`
 * deliberatamente best-effort di `startRun`. L'esito lo DICE
 * ({@link ProceedWithProposalError.run_not_started}) invece di fingere un
 * fallimento totale o un successo pieno.
 */
import { notifications, users, type Db } from "@stubwise/db";
import { actorAllows } from "@stubwise/notifications";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { convertBacklogItem } from "./backlog.js";
import { startRun, type Actor } from "./jobs.js";
import { mirrorDecision, propagateHandled } from "./notifications-propagation.js";

/** Errori tipizzati di {@link proceedWithProposal}, mappati a HTTP dalle rotte. */
export type ProceedWithProposalError =
  /** Nessun pulse con quell'id (o è di un altro utente: lo filtra `executeAction`). */
  | "not_found"
  | "forbidden"
  /** Indice assente, non intero o fuori dalle proposte PERSISTITE nell'evento. */
  | "invalid_answer"
  /** Il pulse è già stato deciso (o archiviato) da qualcuno: chi, se si sa. */
  | "already_handled"
  /**
   * La proposta non è più valida: la voce è sparita, è archiviata, o l'ha già
   * convertita qualcun altro. Le tre cause sono UNA sola per chi guarda la
   * card — la proposta non si può più prendere — e non vale la pena
   * distinguerle in tre 409 diversi.
   */
  | "proposal_stale"
  /**
   * Il ticket è nato ma il run non è partito (vedi il docblock del modulo).
   * L'esito porta `ticketId`/`ticketNumber`: c'è qualcosa da aprire, e da
   * lanciare a mano.
   */
  | "run_not_started";

/** Chi ha già deciso il pulse: l'id per la UI, l'email per dirlo a parole. */
export interface HandledBy {
  id: string;
  email: string;
}

export type ProceedWithProposalResult =
  | {
      ok: true;
      ticketId: string;
      ticketNumber: number;
      jobId: string;
      /**
       * Come è nato il run, e sono due esperienze diverse: col piano ereditato
       * dalla voce il job è GIÀ fermo sul gate (`awaiting_plan_approval`),
       * senza piano parte `queued` e sarà il worker a fermarsi a piano pronto.
       * Le superfici lo dicono con parole diverse invece di promettere uno
       * stato che l'utente non vedrà subito.
       */
      status: "queued" | "awaiting_plan_approval";
      /** Copie del pulse chiuse dalla decisione (tutte, di tutti i destinatari). */
      changedNotificationIds: string[];
    }
  | {
      ok: false;
      error: ProceedWithProposalError;
      handledBy?: HandledBy;
      /** Solo su `run_not_started`: il ticket c'è, e si può aprire. */
      ticketId?: string;
      ticketNumber?: number;
    };

export interface ProceedWithProposalInput {
  /**
   * La riga d'inbox su cui si è premuto. NON si verifica qui che sia di chi
   * agisce: lo fa `executeAction`, da cui passano tutte le superfici (una riga
   * altrui è `not_found`, e non se ne rivela l'esistenza).
   *
   * ⚠️ A DIFFERENZA di `answerQuestion`, per il pulse quel filtro è l'UNICO
   * controllo d'accesso che esista: `actorAllows` sul pulse risponde sempre sì
   * (è una proposta rivolta a chiunque l'abbia ricevuta, operatori compresi).
   * Chi chiamasse questo servizio saltando `executeAction` potrebbe quindi
   * decidere il pulse di un altro. Nessun chiamante lo fa oggi, e nessuno deve
   * acquisirlo senza portarsi dietro il `WHERE` sull'utente.
   */
  notificationId: string;
  actor: Actor;
  /**
   * Indice della proposta scelta. Opzionale nella FORMA perché le superfici
   * possono mandare altro (il pulse ha `allowFreeText: false`, ma il corpo
   * della rotta `answer` ammette anche un testo): la validazione di merito —
   * intero, dentro il range delle proposte persistite — è qui, in un posto
   * solo.
   */
  optionIndex?: number;
  /** PUBLIC_URL, inoltrato a `startRun` per il link della `job.plan_review`. */
  publicUrl?: string;
}

/**
 * Quel poco del payload del pulse che serve ad agire: l'ancora di propagazione
 * e le proposte. Volutamente PARZIALE (nessuna validazione di `question`,
 * `options`, `idleDays`): un payload scritto da una versione precedente deve
 * poter essere ancora azionabile se porta ciò che conta.
 */
const pulsePayloadSchema = z.object({
  pulseId: z.uuid(),
  proposals: z.array(z.object({ backlogItemId: z.uuid(), title: z.string() })).min(1),
});

/**
 * Converte la proposta scelta in un ticket e ne avvia il run con approvazione
 * obbligatoria.
 *
 * ORDINE DELLE OPERAZIONI, e perché:
 *
 *  1. lettura del pulse (solo `project.pulse`), permesso (`actorAllows`) e
 *     validazione dell'indice contro le proposte PERSISTITE — non contro quelle
 *     che il client crede di avere;
 *  2. **il claim**: `propagateHandled` sulla chiave `pulseId` chiude in un solo
 *     UPDATE guardato TUTTE le copie del pulse. È qui, PRIMA di convertire, che
 *     si decide chi vince: il claim di `convertBacklogItem` protegge dal doppio
 *     ticket sulla STESSA voce, ma due "Procedi" concorrenti su proposte
 *     DIVERSE dello stesso pulse convertirebbero due voci e lancerebbero due
 *     run. Due UPDATE concorrenti sulle stesse righe si serializzano sul lock
 *     di riga e il secondo rilegge `status = 'handled'` → 0 righe → ha perso.
 *     PREZZO: se ciò che segue esplode per un errore infrastrutturale il pulse
 *     resta chiuso senza che sia successo nulla (lo ripropone il tick
 *     successivo del poller).
 *
 *     L'ALTERNATIVA REALE, per chi un giorno valutasse di rifattorizzare, non è
 *     "convertire prima" (che riaprirebbe il doppio run) ma **claim + convert in
 *     un'unica transazione esterna**: `convertBacklogItem` prende un `Db`, e la
 *     sua transazione diventerebbe un savepoint annidato. Restringerebbe davvero
 *     il prezzo di cui sopra al solo `startRun` — che è già coperto da
 *     `run_not_started`. È stata scartata, non per impossibilità, per tre
 *     ragioni: terrebbe i lock su N righe di `notifications` (una per
 *     destinatario) per tutta la durata del convert, che apre un ticket e chiude
 *     una sessione di analisi; anniderebbe savepoint dentro una transazione
 *     aperta da un servizio che oggi non ne apre; e romperebbe la disciplina
 *     della fase 1, dove la propagazione sta FUORI da ogni transazione perché
 *     porta con sé I/O esterno best-effort. Se un giorno il "pulse chiuso a
 *     vuoto" si rivelasse un problema reale (e non un'ipotesi su un errore
 *     infrastrutturale), è quella la strada;
 *  3. `convertBacklogItem`: voce → ticket `task`, con il suo claim anti-TOCTOU;
 *  4. `startRun({ requirePlanApproval: true })`: il run nasce dietro il gate
 *     anche per un maintainer — chi clicca accetta una PROPOSTA, non ha letto
 *     un piano;
 *  5. la nota sui DM Slack (`mirrorDecision`), che è l'unica parte che dipende
 *     dall'esito: avviato-e-fermo, avviato-e-in-pianificazione, ticket-senza-run
 *     o proposta-scaduta. Best-effort e fuori da ogni transazione: un problema
 *     di Slack non deve poter annullare un run già partito.
 */
export async function proceedWithProposal(
  db: Db,
  input: ProceedWithProposalInput,
): Promise<ProceedWithProposalResult> {
  const { actor } = input;

  const [row] = await db
    .select({ status: notifications.status, event: notifications.event })
    .from(notifications)
    .where(
      and(eq(notifications.id, input.notificationId), eq(notifications.kind, "project.pulse")),
    );
  if (!row) return { ok: false, error: "not_found" };

  // Il permesso vive in `actorAllows` (unica sede) e qui si RI-APPLICA: sul
  // pulse oggi risponde sempre sì, ma se un giorno la regola cambiasse questo
  // servizio la seguirebbe invece di restare indietro con una copia sua.
  if (!actorAllows({ kind: "project.pulse", requestedByUserId: null }, "answer", actor)) {
    return { ok: false, error: "forbidden" };
  }

  // Il payload è jsonb non validato dal DB: senza `pulseId` non si può nemmeno
  // propagare la decisione, quindi la proposta non è azionabile — che per chi
  // guarda la card è la stessa cosa di una proposta scaduta.
  const parsed = pulsePayloadSchema.safeParse(row.event);
  if (!parsed.success) return { ok: false, error: "proposal_stale" };
  const { pulseId, proposals } = parsed.data;

  const index = input.optionIndex;
  if (index === undefined || !Number.isInteger(index) || index < 0 || index >= proposals.length) {
    return { ok: false, error: "invalid_answer" };
  }
  const proposal = proposals[index]!;

  // Pre-check prima del claim: una riga non `open` non è azionabile, e dirlo
  // qui evita di chiudere le copie altrui per una richiesta che non poteva
  // riuscire.
  //
  // COMPRESA LA RIGA SNOOZED, e l'imprecisione è nota: `already_handled` su una
  // riga che il richiedente stesso ha solo RINVIATO dice più di quel che è
  // successo (e il 409 esce senza `handledBy`, perché nessuno l'ha gestita).
  // Non è un buco: lo snooze toglie i bottoni dal DM e la riga sparisce
  // dall'inbox aperta, quindi non c'è superficie da cui premere; e quando
  // riemerge, il lazy-reopen di `listInbox` l'ha già riportata `open`, cioè
  // azionabile. Un errore dedicato costerebbe un case in più su tutte e tre le
  // superfici per uno stato che nessuno può vedere.
  if (row.status !== "open") {
    return {
      ok: false,
      error: "already_handled",
      ...(await handledByOf(db, input.notificationId)),
    };
  }

  const changedNotificationIds = await propagateHandled(db, { pulseId }, actor.id);
  // Claim perso: qualcun altro ha deciso questo pulse fra il pre-check e ora.
  if (changedNotificationIds.length === 0) {
    return {
      ok: false,
      error: "already_handled",
      ...(await handledByOf(db, input.notificationId)),
    };
  }

  const converted = await convertBacklogItem(db, { itemId: proposal.backlogItemId, actor });
  if (!converted.ok) {
    // `already_converted` e `not_convertible` (e la voce sparita) sono la stessa
    // notizia per chi guarda la card: quella proposta non si può più prendere.
    // Le copie restano CHIUSE — riaprirle rimetterebbe in inbox un invito a
    // un'azione impossibile — con la nota che spiega perché.
    await mirrorDecision(db, {
      notificationIds: changedNotificationIds,
      action: "answer",
      actorId: actor.id,
      pulse: { title: proposal.title, outcome: "stale" },
    });
    return { ok: false, error: "proposal_stale" };
  }

  const run = await startRun(db, {
    ticketId: converted.ticketId,
    actor,
    requirePlanApproval: true,
    ...(input.publicUrl ? { publicUrl: input.publicUrl } : {}),
  });
  if (!run.ok) {
    // Il ticket c'è: la nota lo dice e non promette un run che non esiste.
    await mirrorDecision(db, {
      notificationIds: changedNotificationIds,
      action: "answer",
      actorId: actor.id,
      pulse: { title: proposal.title, outcome: "ticket_only" },
    });
    return {
      ok: false,
      error: "run_not_started",
      ticketId: converted.ticketId,
      ticketNumber: converted.ticketNumber,
    };
  }

  await mirrorDecision(db, {
    notificationIds: changedNotificationIds,
    action: "answer",
    actorId: actor.id,
    pulse: {
      title: proposal.title,
      outcome: run.status === "awaiting_plan_approval" ? "awaiting_approval" : "planning",
    },
  });
  return {
    ok: true,
    ticketId: converted.ticketId,
    ticketNumber: converted.ticketNumber,
    jobId: run.jobId,
    status: run.status,
    changedNotificationIds,
  };
}

/**
 * Chi ha chiuso la riga, per il 409 che deve poter dire "l'ha già presa X".
 *
 * LEFT JOIN e non INNER: `handled_by_user_id` è ON DELETE SET NULL (ed è nullo
 * quando a chiudere è stato il sistema), quindi una riga chiusa resta chiusa
 * anche senza un nome da fare.
 */
async function handledByOf(db: Db, notificationId: string): Promise<{ handledBy?: HandledBy }> {
  const [row] = await db
    .select({ id: users.id, email: users.email })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.handledByUserId))
    .where(eq(notifications.id, notificationId));
  return row?.id && row.email ? { handledBy: { id: row.id, email: row.email } } : {};
}
