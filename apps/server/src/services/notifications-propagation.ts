/**
 * PROPAGAZIONE di una decisione sull'inbox.
 *
 * Quando qualcuno decide qualcosa su un job (approva un piano, lo rifiuta,
 * rilancia un fix) le righe `notifications` di TUTTI i destinatari di
 * quell'evento vanno chiuse — la decisione è una sola per tutti —, da
 * qualunque superficie sia stata presa (la pagina della task, l'inbox, l'MCP).
 *
 * Fino al ritiro del web vecchio (R2) questo modulo rispecchiava anche la
 * decisione sui DM Slack già inviati: Slack non c'è più, resta la chiusura.
 *
 * PERCHÉ UN MODULO A PARTE: `./inbox.ts` importa `./jobs.ts` (per
 * `resolvePlan`/`startRun`), quindi `./jobs.ts` non può importare da
 * `./inbox.ts` senza chiudere un ciclo. Qui dentro le dipendenze sono solo
 * `db`: nessuno può creare un ciclo importandolo.
 */
import { notifications, type Db } from "@stubwise/db";
import { type DbOrTx, type NotificationKind } from "@stubwise/notifications";
import { and, eq, ne, sql, type SQL } from "drizzle-orm";

/**
 * Bersaglio della chiusura: tutte le copie di un evento (`jobId` + `kind`),
 * tutte le copie di una proposta ANCORATA NEL JSONB — pulse o proposta Google,
 * che un job dietro non ce l'hanno — o, quando non c'è nessuna delle due
 * ancore, la singola riga.
 *
 * `eventKey` GENERALIZZA quello che prima era il solo caso `{ pulseId }`
 * (fase 6, Task 11): `kind` è un'etichetta SEMANTICA — non il valore
 * dell'enum `notification_kind`, vedi {@link EVENT_KEY_NOTIFICATION_KIND} —
 * `field` è la chiave del jsonb `event` da confrontare (`pulseId`,
 * `proposalId`) e `value` l'ancora da cercare. Il pulse (che chiamava
 * `propagateHandled(db, { pulseId }, actorId)`) ora chiama
 * `propagateHandled(db, { eventKey: { kind: "pulse", field: "pulseId", value:
 * pulseId } }, actorId)`: stesso comportamento, forma condivisa con
 * `google.proposal` invece di un caso a parte.
 */
export type PropagationTarget =
  | { jobId: string; kind: NotificationKind }
  | { eventKey: { kind: string; field: string; value: string } }
  | { notificationId: string };

/**
 * Il `notifications.kind` (enum DB) dietro ciascuna etichetta semantica di
 * {@link PropagationTarget}'s `eventKey.kind`. Tenerla qui, e non lasciare che
 * il chiamante passi direttamente l'enum, è ciò che rende `eventKey`
 * riusabile da un domani terzo caso senza dover ricordare la stringa esatta
 * dell'enum: l'etichetta (`"pulse"`, `"google_proposal"`) è mnemonica, la
 * traduzione vive in un posto solo.
 */
const EVENT_KEY_NOTIFICATION_KIND: Record<string, NotificationKind> = {
  pulse: "project.pulse",
  google_proposal: "google.proposal",
  // Fase permessi: le copie della proposta PASSATA ai decisori del progetto
  // (stesso `proposalId` = `email_proposals.id`, kind diverso: chiudere le une
  // non chiude le altre).
  google_proposal_handed: "google.proposal_handed",
};

/** La chiave del jsonb è un identificatore semplice? Difesa contro un refuso che finirebbe in SQL grezzo. */
const SIMPLE_FIELD_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * WHERE del bersaglio.
 *
 * ⚠️ IL RAMO `eventKey` NON HA SEMPRE UN INDICE. `field` vive nel jsonb
 * `event` (`event->>'<field>'`): per `proposalId` (`google.proposal`) c'è
 * l'indice parziale `notifications_proposal_id_idx` del Task 1
 * (`(event->>'proposalId') WHERE (event->>'proposalId') is not null`), e la
 * query qui sotto lo può usare SOLO perché il nome del campo resta un
 * LETTERALE nel testo SQL (`sql.raw`) e non un parametro — un `->>$1` non
 * combacerebbe mai con l'espressione indicizzata, che il planner confronta
 * testualmente. Per `pulseId` (`project.pulse`) resta il seq scan MISURATO e
 * documentato di sempre (nessun indice, misura sotto):
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
 * Il filtro su `kind` non serve sempre al piano ma serve sempre alla
 * CORRETTEZZA (nessun altro kind porta lo stesso campo) e restringe comunque
 * le righe confrontate.
 */
function targetWhere(target: PropagationTarget): SQL {
  if ("jobId" in target) {
    return and(eq(notifications.jobId, target.jobId), eq(notifications.kind, target.kind))!;
  }
  if ("eventKey" in target) {
    const { kind, field, value } = target.eventKey;
    const notificationKind = EVENT_KEY_NOTIFICATION_KIND[kind];
    if (!notificationKind) throw new Error(`eventKey.kind sconosciuto: ${kind}`);
    if (!SIMPLE_FIELD_NAME.test(field)) throw new Error(`eventKey.field non valido: ${field}`);
    return and(
      eq(notifications.kind, notificationKind),
      // Il nome del campo è un LETTERALE nel testo SQL (guardato dalla regex
      // sopra), non un bind parameter: solo così l'espressione combacia con
      // l'indice parziale su `event->>'proposalId'`. Il VALORE resta
      // parametrizzato normalmente.
      sql`${notifications.event}->>${sql.raw(`'${field}'`)} = ${value}`,
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
  // Anche una transazione: il «Passa al progetto» chiude la card del
  // proprietario e pubblica quella dei decisori INSIEME.
  db: DbOrTx,
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
      handledAction: "decision",
    })
    .where(and(targetWhere(target), ne(notifications.status, "handled")))
    .returning({ id: notifications.id });
  // Area 9, F1 (review, I3): una copia già ARCHIVIATA resta chiusa com'è, ma
  // diventa decisa: «Restore» non deve riaprirla su una decisione già presa.
  await db
    .update(notifications)
    .set({ handledAction: "decision" })
    .where(and(targetWhere(target), eq(notifications.status, "handled"), eq(notifications.handledAction, "archive")));
  return closed.map((row) => row.id);
}

/**
 * Chiude le copie di un evento: la conseguenza di OGNI decisione, da qualunque
 * superficie sia stata presa. (Fino al ritiro del web vecchio, R2, accodava
 * anche la riscrittura dei DM Slack.)
 *
 * @returns gli id delle righe chiuse, per il chiamante che deve riferirli.
 */
export async function propagateDecision(
  db: Db,
  args: { target: PropagationTarget; actorId: string },
): Promise<string[]> {
  return propagateHandled(db, args.target, args.actorId);
}
