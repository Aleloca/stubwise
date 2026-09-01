/**
 * PROPAGAZIONE di una decisione sull'inbox, e suo RISPECCHIAMENTO sui DM Slack.
 *
 * Quando qualcuno decide qualcosa su un job (approva un piano, lo rifiuta,
 * rilancia un fix) succedono due cose che NON dipendono da quale superficie ha
 * preso la decisione:
 *  1. le righe `notifications` di TUTTI i destinatari di quell'evento vanno
 *     chiuse — la decisione è una sola per tutti;
 *  2. i DM Slack già inviati per quelle righe vanno riscritti, altrimenti
 *     restano lì con dei bottoni che promettono un'azione già presa.
 *
 * Questo modulo è il posto unico dove quelle due cose vivono. Prima stavano in
 * `./inbox.ts` (`executeAction`) e in `../slack/inbox-actions.ts`, cioè solo
 * sulle superfici inbox e Slack: una decisione presa dalla PAGINA TICKET —
 * `POST /tickets/:id/approve-plan`, che chiama `resolvePlan` diretto, ed è la
 * strada più probabile per un admin — lasciava le copie aperte e i DM stale.
 *
 * PERCHÉ UN MODULO A PARTE e non l'uno o l'altro dei due file: `./inbox.ts`
 * importa `./jobs.ts` (per `resolvePlan`/`startRun`), quindi `./jobs.ts` non
 * può importare da `./inbox.ts` senza chiudere un ciclo; e
 * `../slack/inbox-actions.ts` importa a sua volta `./inbox.ts`, quindi nemmeno
 * da lì. Qui dentro le dipendenze sono solo `db` e `i18n`: nessuno può creare
 * un ciclo importandolo.
 */
import { notificationDeliveries, notifications, users, type Db } from "@stubwise/db";
import { t, type Language } from "@stubwise/i18n";
import { escapeSlackMrkdwn, type ActionId, type NotificationKind } from "@stubwise/notifications";
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";

/**
 * Bersaglio della chiusura: tutte le copie di un evento (`jobId` + `kind`),
 * tutte le copie di un PULSE (che un job dietro non ce l'ha) o, quando non c'è
 * nessuna delle due ancore, la singola riga.
 */
export type PropagationTarget =
  | { jobId: string; kind: NotificationKind }
  | { pulseId: string }
  | { notificationId: string };

/**
 * WHERE del bersaglio.
 *
 * ⚠️ IL RAMO `pulseId` NON HA UN INDICE: `pulseId` vive nel jsonb `event`
 * (`event->>'pulseId'`), e su `notifications` non c'è né un indice su `kind` né
 * uno di espressione su quel campo — quindi è un seq scan sulla tabella. È una
 * scelta MISURATA, non un'omissione. `EXPLAIN (ANALYZE, BUFFERS)` su un
 * Postgres di test caricato a 50.003 righe (1 settembre 2026):
 *
 *   Seq Scan on notifications  (cost=0.00..1695.05 rows=1) (actual 2.778..2.779 rows=3)
 *     Filter: kind = 'project.pulse' AND (event->>'pulseId') = '…'
 *     Rows Removed by Filter: 50000
 *     Buffers: shared hit=820        Execution Time: 2.795 ms
 *
 * ~2,8 ms per scandire 50k righe, tutte in cache. Per confronto, l'istanza di
 * produzione alla stessa data ha 10 righe in `notifications` (80 kB): quattro
 * ordini di grandezza sotto la misura. E il "Procedi" è un'azione a ritmo umano,
 * poche volte al giorno.
 *
 * Il filtro su `kind` non serve al piano ma alla CORRETTEZZA (nessun altro
 * evento porta un `pulseId`) e restringe comunque le righe confrontate. Se un
 * giorno `notifications` crescesse di ordini di grandezza — è la misura sopra a
 * dire quando conviene rifarla — l'indice giusto è parziale:
 * `(event->>'pulseId') WHERE kind = 'project.pulse'`.
 */
function targetWhere(target: PropagationTarget): SQL {
  if ("jobId" in target) {
    return and(eq(notifications.jobId, target.jobId), eq(notifications.kind, target.kind))!;
  }
  if ("pulseId" in target) {
    return and(
      eq(notifications.kind, "project.pulse"),
      sql`${notifications.event}->>'pulseId' = ${target.pulseId}`,
    )!;
  }
  return eq(notifications.id, target.notificationId);
}

/**
 * Chiude le righe d'inbox bersaglio ancora aperte, attribuendole ad `actorId`.
 *
 * Un solo UPDATE guardato su `status <> 'handled'`, quindi atomico e
 * idempotente: chi era già chiuso conserva il suo `handled_by` e non ricompare
 * fra le righe cambiate.
 *
 * Il `kind` fa parte della chiave apposta: sullo stesso job convivono notifiche
 * diverse (il `job.failed` di ieri e il `job.plan_review` di oggi), e approvare
 * il piano non deve archiviare il fallimento precedente.
 *
 * @returns gli id delle righe effettivamente chiuse — quelle il cui DM Slack va
 *   riscritto (vedi {@link mirrorDecision}).
 */
export async function propagateHandled(
  db: Db,
  target: PropagationTarget,
  actorId: string,
): Promise<string[]> {
  const closed = await db
    .update(notifications)
    .set({
      status: "handled",
      handledAt: sql`now()`,
      handledByUserId: actorId,
      snoozedUntil: null,
    })
    .where(and(targetWhere(target), ne(notifications.status, "handled")))
    .returning({ id: notifications.id });
  return closed.map((row) => row.id);
}

/** Chiave i18n della nota di stato per ciascuna azione andata a buon fine. */
const NOTE_KEY: Record<Exclude<ActionId, "open">, string> = {
  approve_plan: "notify.inbox.notePlanApproved",
  reject_plan: "notify.inbox.notePlanRejected",
  relaunch: "notify.inbox.noteRelaunched",
  answer: "notify.inbox.noteAnswered",
  handled: "notify.inbox.noteHandled",
  snooze: "notify.inbox.noteSnoozed",
};

/**
 * ESITO del "Procedi" del pulse, che sceglie la nota fra le sue varianti.
 *
 * Non è una sfumatura estetica: al lettore del DM servono parole diverse a
 * seconda di cosa è successo davvero. Col piano ereditato dalla voce il run è
 * GIÀ fermo sul gate (`awaiting_approval`); senza piano la pianificazione parte
 * e si fermerà dopo (`planning`) — promettere il primo stato nel secondo caso
 * farebbe cercare un'approvazione che ancora non esiste. `ticket_only` è il
 * ticket nato senza run (vedi `services/pulse.ts`), `stale` la proposta che
 * qualcun altro aveva già preso.
 */
export type PulseNoteOutcome = "awaiting_approval" | "planning" | "ticket_only" | "stale";

/** Chiave i18n della nota per ciascun esito del "Procedi". */
const PULSE_NOTE_KEY: Record<PulseNoteOutcome, string> = {
  awaiting_approval: "notify.inbox.notePulseStartedApproval",
  planning: "notify.inbox.notePulseStartedPlanning",
  ticket_only: "notify.inbox.notePulseTicketOnly",
  stale: "notify.inbox.notePulseStale",
};

/** La proposta scelta e come è andata: quanto basta a comporre la nota del pulse. */
export interface PulseNote {
  title: string;
  outcome: PulseNoteOutcome;
}

/**
 * Data resa con il token di Slack `<!date^…>`: la scadenza dello snooze compare
 * nel FUSO ORARIO di chi legge, senza che noi si debba sapere qual è. Il testo
 * dopo la barra è il fallback (client vecchi, notifiche push).
 */
function slackDate(date: Date): string {
  const epoch = Math.floor(date.getTime() / 1000);
  return `<!date^${epoch}^{date_short_pretty} {time}|${date.toISOString()}>`;
}

/** Quanto della risposta entra nella nota del DM. */
const NOTE_ANSWER_MAX_CHARS = 200;

/**
 * Riduce la risposta a UNA riga corta: la nota è una didascalia in coda a un DM,
 * non il posto dove rileggere quattromila caratteri di testo libero (la risposta
 * per intero resta sul ticket, nel commento di sistema).
 */
function truncateNote(answer: string): string {
  const oneLine = answer.replace(/\s+/g, " ").trim();
  // Taglio per PUNTO DI CODICE (`Array.from`) e non per code unit UTF-16:
  // `slice` su una stringa che contiene un'emoji può spezzarne la coppia di
  // surrogati proprio al confine, e la nota arriverebbe su Slack con un
  // carattere rotto.
  const points = Array.from(oneLine);
  return points.length > NOTE_ANSWER_MAX_CHARS
    ? `${points.slice(0, NOTE_ANSWER_MAX_CHARS - 1).join("")}…`
    : oneLine;
}

/**
 * Riga di stato da appendere al messaggio dopo l'azione ("✅ Piano approvato da
 * …"), nella lingua di chi la leggerà.
 *
 * Porta del markup Slack (il token data) perché i suoi unici lettori sono
 * messaggi Slack: la nota nasce per essere appesa a un DM.
 */
export function inboxNote(
  action: Exclude<ActionId, "open">,
  lang: Language,
  args: { actor: string; snoozedUntil?: Date; answer?: string; pulse?: PulseNote },
): string {
  if (action === "snooze") {
    return t(lang, NOTE_KEY.snooze, {
      until: args.snoozedUntil ? slackDate(args.snoozedUntil) : "—",
    });
  }
  if (action === "answer") {
    // Il PULSE condivide l'azione `answer` con la domanda dell'agente ma non la
    // sua nota: là si riferisce una risposta, qui si annuncia un lavoro
    // avviato. Il titolo passa dallo stesso taglio+escape della risposta (una
    // voce di backlog può avere un titolo lungo, e finisce in un `section`).
    if (args.pulse) {
      return t(lang, PULSE_NOTE_KEY[args.pulse.outcome], {
        actor: args.actor,
        title: escapeSlackMrkdwn(truncateNote(args.pulse.title)),
      });
    }
    // La nota della risposta PORTA la risposta: chi legge il DM di un collega
    // deve sapere cosa è stato deciso, non solo che qualcuno ha deciso.
    //
    // Accorciata e escapata QUI, che è il punto da cui passano ENTRAMBE le
    // strade (la copia riscritta subito via `response_url` e quelle accodate da
    // `mirrorDecision`): una sola applicazione, quindi le due copie dello stesso
    // messaggio dicono la stessa cosa e nessuna delle due può sforare i 3000
    // caratteri di una `section` con una risposta libera da 4000.
    //
    // ORDINE: prima si taglia, poi si escapa. Al contrario il taglio cadrebbe
    // in mezzo a un'entità (`&am…`) e il testo arriverebbe rotto.
    return t(lang, NOTE_KEY.answer, {
      actor: args.actor,
      answer: args.answer ? escapeSlackMrkdwn(truncateNote(args.answer)) : "—",
    });
  }
  return t(lang, NOTE_KEY[action], { actor: args.actor });
}

/**
 * Accoda una consegna `slack_update` per ciascuna notifica: il poller del worker
 * riscriverà il DM di quel destinatario togliendo i bottoni e aggiungendo la
 * nota, nella lingua del destinatario stesso (per questo la nota è una funzione
 * della lingua e non una stringa).
 *
 * Si accoda anche per chi non ha Slack collegato: la riga costa nulla e il
 * poller la chiude `skipped` quando non trova il DM sorella da aggiornare.
 */
export async function enqueueInboxUpdates(
  db: Db,
  notificationIds: string[],
  note: (lang: Language) => string,
): Promise<void> {
  if (notificationIds.length === 0) return;
  const rows = await db
    .select({ id: notifications.id, language: users.language })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(inArray(notifications.id, notificationIds));
  if (rows.length === 0) return;
  await db.insert(notificationDeliveries).values(
    rows.map((row) => ({
      notificationId: row.id,
      channel: "slack_update" as const,
      event: { note: note(row.language) },
    })),
  );
}

/**
 * Rispecchia su Slack un cambio di stato dell'inbox: accoda l'aggiornamento del
 * DM di ogni riga cambiata, con la nota dell'azione nella lingua di chi lo
 * leggerà.
 *
 * L'email dell'attore (che compare nella nota, "approvato da …") si risolve
 * qui: i chiamanti hanno in mano solo il suo id.
 *
 * BEST-EFFORT, non lancia mai. Il rispecchiamento è la *conseguenza* di una
 * decisione già presa e già scritta: se Slack o la coda avessero un problema,
 * far fallire l'approvazione a valle sarebbe il rimedio peggiore del male —
 * l'utente vedrebbe un errore su un piano che nel frattempo è partito.
 *
 * NOTA sulla copia di chi ha premuto un bottone Slack: `runInboxAction` riscrive
 * subito il SUO messaggio via `response_url`, e questa coda glielo riscriverà
 * una seconda volta con lo stesso contenuto. È voluto: `sendSlackUpdate` porta
 * il messaggio a uno stato finale deterministico (testo + nota, niente
 * bottoni), quindi la seconda scrittura è idempotente, e costa una chiamata
 * `chat.update` su un'azione a ritmo umano. Il prezzo è preferibile all'unica
 * alternativa — far sapere a questo modulo quale superficie ha già rinfrescato
 * cosa — che rimetterebbe nel servizio la conoscenza di Slack che stiamo
 * togliendo.
 */
export async function mirrorDecision(
  db: Db,
  args: {
    notificationIds: string[];
    action: Exclude<ActionId, "open">;
    actorId: string;
    snoozedUntil?: Date;
    /**
     * La risposta data, già resa in una riga (solo per `answer`): la nota del DM
     * la PORTA, perché chi legge il messaggio di un collega deve sapere cosa è
     * stato deciso, non solo che qualcuno ha deciso.
     */
    answer?: string;
    /**
     * Solo per il "Procedi" del pulse: la proposta scelta e come è andata. È
     * alternativo ad `answer` — sono due note diverse della stessa azione.
     */
    pulse?: PulseNote;
  },
): Promise<void> {
  if (args.notificationIds.length === 0) return;
  try {
    const [actor] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, args.actorId));
    const noteArgs = {
      // L'email è ciò che identifica la persona nella nota. Se l'utente è
      // sparito fra la decisione e qui, la nota resta comunque leggibile.
      actor: actor?.email ?? "—",
      ...(args.snoozedUntil ? { snoozedUntil: args.snoozedUntil } : {}),
      // Niente troncatura qui: la fa `inboxNote`, che è il punto comune a
      // tutte le superfici.
      ...(args.answer === undefined ? {} : { answer: args.answer }),
      ...(args.pulse === undefined ? {} : { pulse: args.pulse }),
    };
    await enqueueInboxUpdates(db, args.notificationIds, (lang) =>
      inboxNote(args.action, lang, noteArgs),
    );
  } catch {
    // Inghiottito di proposito: vedi il docblock.
  }
}

/**
 * Chiude le copie e ne accoda il rispecchiamento su Slack: la coppia che segue
 * OGNI decisione, da qualunque superficie sia stata presa.
 *
 * @returns gli id delle righe chiuse, per il chiamante che deve riferirli.
 */
export async function propagateDecision(
  db: Db,
  args: {
    target: PropagationTarget;
    action: Exclude<ActionId, "open">;
    actorId: string;
    /** Solo per `answer`: la risposta resa in una riga, da mettere nella nota. */
    answer?: string;
    /** Solo per il "Procedi" del pulse: la proposta scelta e come è andata. */
    pulse?: PulseNote;
  },
): Promise<string[]> {
  const changed = await propagateHandled(db, args.target, args.actorId);
  await mirrorDecision(db, {
    notificationIds: changed,
    action: args.action,
    actorId: args.actorId,
    ...(args.answer === undefined ? {} : { answer: args.answer }),
    ...(args.pulse === undefined ? {} : { pulse: args.pulse }),
  });
  return changed;
}
