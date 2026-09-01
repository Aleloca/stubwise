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
import type { ActionId, NotificationKind } from "@stubwise/notifications";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

/**
 * Bersaglio della chiusura: tutte le copie di un evento (`jobId` + `kind`) o,
 * quando non c'è un job dietro, la singola riga.
 */
export type PropagationTarget =
  | { jobId: string; kind: NotificationKind }
  | { notificationId: string };

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
  const where =
    "jobId" in target
      ? and(eq(notifications.jobId, target.jobId), eq(notifications.kind, target.kind))
      : eq(notifications.id, target.notificationId);
  const closed = await db
    .update(notifications)
    .set({
      status: "handled",
      handledAt: sql`now()`,
      handledByUserId: actorId,
      snoozedUntil: null,
    })
    .where(and(where, ne(notifications.status, "handled")))
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
 * Data resa con il token di Slack `<!date^…>`: la scadenza dello snooze compare
 * nel FUSO ORARIO di chi legge, senza che noi si debba sapere qual è. Il testo
 * dopo la barra è il fallback (client vecchi, notifiche push).
 */
function slackDate(date: Date): string {
  const epoch = Math.floor(date.getTime() / 1000);
  return `<!date^${epoch}^{date_short_pretty} {time}|${date.toISOString()}>`;
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
  args: { actor: string; snoozedUntil?: Date; answer?: string },
): string {
  if (action === "snooze") {
    return t(lang, NOTE_KEY.snooze, {
      until: args.snoozedUntil ? slackDate(args.snoozedUntil) : "—",
    });
  }
  if (action === "answer") {
    // La nota della risposta PORTA la risposta: chi legge il DM di un collega
    // deve sapere cosa è stato deciso, non solo che qualcuno ha deciso.
    return t(lang, NOTE_KEY.answer, { actor: args.actor, answer: args.answer ?? "—" });
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
      ...(args.answer === undefined ? {} : { answer: truncateNote(args.answer) }),
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
  },
): Promise<string[]> {
  const changed = await propagateHandled(db, args.target, args.actorId);
  await mirrorDecision(db, {
    notificationIds: changed,
    action: args.action,
    actorId: args.actorId,
    ...(args.answer === undefined ? {} : { answer: args.answer }),
  });
  return changed;
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
  return oneLine.length > NOTE_ANSWER_MAX_CHARS
    ? `${oneLine.slice(0, NOTE_ANSWER_MAX_CHARS - 1)}…`
    : oneLine;
}
