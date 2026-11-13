import { randomUUID } from "node:crypto";
import {
  automationEffects,
  automationRuns,
  backlogItems,
  createMilestone,
  createRequestItem,
  createTicket,
  mailOutgoing,
  milestones,
  projects,
  type Db,
} from "@stubwise/db";
import { automationMailboxOf, loadPlanWorld, milestoneNameTaken, publishNotification } from "@stubwise/notifications";
import {
  failed,
  MAIL_OUTGOING_CHANNEL,
  planEmail,
  planMilestone,
  planNotify,
  planRequest,
  planTask,
  sameConversation,
  type ActionEffect,
  type Automation,
  type EffectOutcome,
  type EffectRequest,
} from "@stubwise/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * L'UNICO ESECUTORE DEGLI EFFETTI delle automazioni nel worker (area 7,
 * fetta 1; la specifica è `data/automations/effects.ts` del prototipo). Il
 * motore chiede (`EffectRequest`), questo modulo fa — con le scritture di
 * oggi (`createTicket`, `createMilestone`, `createRequestItem` di
 * `@stubwise/db`, `publishNotification`), a nome del PROPRIETARIO e coi suoi
 * permessi, ricontrollati a OGNI effetto dai piani condivisi (`plans.ts`) —
 * e risponde con l'input che rientra nel motore.
 *
 * - IDEMPOTENZA: un effetto per passo e giro (`automation_effects`, chiave
 *   `<run>:<path>:<round>`), scritto nella STESSA transazione della scrittura.
 *   Un passo rifatto (riavvio a metà, lease scaduto) ritrova l'effetto e
 *   risponde come la prima volta, senza duplicare.
 * - ORIGINE: la transazione imposta `stubwise.automation_run_id`, così gli
 *   eventi che la scrittura genera (i trigger della 0169) portano
 *   l'esecuzione e la catena si ferma da lì.
 * - Gli effetti fuori dalla fetta 1 (email, avvio di un'altra, Claude, il
 *   progetto del cliente) non si eseguono: `not_available`. La validazione
 *   impedisce già di pubblicarli; questo è il fondo.
 *
 * Gli errori sono codici macchina; la prosa sta solo nel `reason` della riga.
 */

export interface EffectEnv {
  db: Db;
  runId: string;
  runNumber: number;
  /** Come la leggono i piani: `projectId` e `ownerId` contano. */
  automation: Pick<Automation, "id" | "code" | "name" | "projectId" | "ownerId">;
  /** L'«adesso» dell'esecuzione (ISO). */
  now: string;
  /** La casella scelta all'accensione (area 7, F2): l'id, e l'indirizzo per le frasi. */
  mailbox?: { accountId: string | null; address: string | null };
}

/**
 * Un'email in volo (area 7, F2): l'invio trattenuto è scritto, il mittente
 * della Posta non l'ha ancora mandato. L'esecutore riprova più tardi; il
 * passo non si riesegue (`inFlight` nel cursore).
 */
export interface EffectPending {
  pending: true;
}

/** Il giro di un passo: la fetta 1 non ripete i passi (`repeatUntil` è della F2). */
const ROUND = 0;

export const effectKey = (runId: string, path: string, round = ROUND): string => `${runId}:${path}:${round}`;

const done = (codes: string[], projectId?: string, reason?: string): EffectOutcome => ({
  input: { kind: "effect_result", ok: true, codes, ...(reason ? { reason } : {}) },
  ...(projectId ? { projectId } : {}),
});

const notAvailable = (): EffectOutcome =>
  failed("not_available", { code: "notAvailable" }, "Questo passo non è ancora disponibile: non è stato eseguito.");

const noOwner = (): EffectOutcome =>
  failed("permission_lost", { code: "noOwner" }, "Permesso perso: l'automazione non ha un proprietario.");

/** Le persone e i reparti che un'azione nomina (il mondo li carica). */
function namedIn(eff: ActionEffect): { personIds: string[]; departmentIds: string[] } {
  const personIds: string[] = [];
  const departmentIds: string[] = [];
  for (const who of [(eff.args as { assignee?: unknown }).assignee, (eff.args as { who?: unknown }).who]) {
    if (!who || typeof who !== "object") continue;
    if ("personId" in who && typeof who.personId === "string") personIds.push(who.personId);
    if ("departmentId" in who && typeof who.departmentId === "string") departmentIds.push(who.departmentId);
  }
  return { personIds, departmentIds };
}

async function projectCode(tx: Tx, projectId: string): Promise<string> {
  const [p] = await tx.select({ code: projects.code }).from(projects).where(eq(projects.id, projectId));
  return p?.code ?? "";
}

/** Esegue un effetto a nome del proprietario e restituisce l'input da rimettere nel motore. */
export async function executeEffect(eff: EffectRequest, env: EffectEnv): Promise<EffectOutcome | EffectPending> {
  if (eff.kind === "claude" || eff.kind === "resolve_project") return notAvailable();
  if (eff.kind === "startAutomation") return notAvailable();
  if (eff.kind === "sendEmail") return executeEmail(eff, env);
  const owner = env.automation.ownerId;
  if (!owner) return noOwner();
  const key = effectKey(env.runId, eff.path);
  return env.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('stubwise.automation_run_id', ${env.runId}, true)`);
    // Fatto già (un passo rifatto): la stessa risposta della prima volta.
    const [prev] = await tx.select().from(automationEffects).where(eq(automationEffects.idempotencyKey, key));
    if (prev) return { input: { kind: "effect_result" as const, ok: true, codes: await codesOf(tx, prev.kind, prev.objectId) } };
    const projectIds = [env.automation.projectId, eff.projectTarget?.mode === "fixed" ? eff.projectTarget.projectId : null].filter((p): p is string => !!p);
    const world = await loadPlanWorld(tx, { ownerId: owner, projectIds, ...namedIn(eff) });
    const automation = env.automation as Automation;
    const record = async (kind: "task" | "milestone" | "request" | "notification", objectId: string | null) =>
      tx.insert(automationEffects).values({ runId: env.runId, path: eff.path, round: ROUND, idempotencyKey: key, kind, objectId });

    switch (eff.kind) {
      case "createTask": {
        const p = planTask(world, eff, automation, owner, env.now);
        if (!p.ok) return p.outcome;
        const { plan } = p;
        // Un traguardo creato da un passo precedente, solo se è di questo progetto.
        const [milestone] = plan.milestoneCode
          ? await tx.select({ id: milestones.id }).from(milestones).where(and(eq(milestones.id, plan.milestoneCode), eq(milestones.projectId, plan.projectId)))
          : [];
        const ticket = await createTicket(tx, {
          projectId: plan.projectId,
          title: plan.title,
          body: plan.description,
          type: "task",
          priority: "medium",
          source: "automation",
          requestedByUserId: owner,
          automationRunId: env.runId,
          ...(plan.assignee.assigneeId ? { assigneeId: plan.assignee.assigneeId } : {}),
          ...(plan.departmentId ? { departmentId: plan.departmentId } : {}),
          ...(plan.dueDate ? { dueDate: plan.dueDate } : {}),
          ...(milestone ? { milestoneId: milestone.id } : {}),
        });
        await record("task", ticket.id);
        return done([`${await projectCode(tx, plan.projectId)}-${ticket.number}`], plan.projectId, plan.assignee.reason);
      }
      case "createMilestone": {
        const p = planMilestone(world, eff, automation, owner, env.now);
        if (!p.ok) return p.outcome;
        // Il nome è unico per progetto: «esiste già» è un dato non valido, non un guasto.
        if (await milestoneNameTaken(tx, p.plan.projectId, p.plan.name)) {
          return failed("invalid_input", { code: "milestoneExists", params: { name: p.plan.name } }, `Un traguardo «${p.plan.name}» esiste già nel progetto.`);
        }
        const created = await createMilestone(tx, { projectId: p.plan.projectId, name: p.plan.name, dueDate: p.plan.dueDate, automationRunId: env.runId });
        if (!created.ok) {
          return failed("invalid_input", { code: "invalidInput", params: { message: created.error } }, `Dati non validi per il passo (${created.error}).`);
        }
        await record("milestone", created.milestone.id);
        return done([created.milestone.id], p.plan.projectId);
      }
      case "createRequest": {
        const p = planRequest(world, eff, automation, owner);
        if (!p.ok) return p.outcome;
        const itemId = await createRequestItem(tx, { projectId: p.plan.projectId, title: p.plan.title, document: p.plan.description, requesterId: owner, automationRunId: env.runId, estimate: false });
        await record("request", itemId);
        return done(await codesOf(tx, "request", itemId), p.plan.projectId);
      }
      case "notify": {
        const p = planNotify(world, eff, automation, owner);
        if (!p.ok) return p.outcome;
        const ids: string[] = [];
        // Uno per persona: ognuno legge e archivia il suo.
        for (const personId of p.plan.personIds) {
          const out = await publishNotification(
            tx,
            {
              kind: "automation.notify",
              projectId: p.plan.projectId ?? env.automation.projectId ?? "",
              automationId: env.automation.id,
              automationCode: env.automation.code,
              automationName: env.automation.name,
              runId: env.runId,
              runNumber: env.runNumber,
              message: p.plan.text,
            },
            { ...(p.plan.projectId ? { projectId: p.plan.projectId } : {}), accountUserId: personId },
          );
          ids.push(...out.notificationIds);
        }
        await record("notification", ids[0] ?? null);
        return done(ids, p.plan.projectId ?? undefined);
      }
      default:
        return notAvailable();
    }
  });
}

/** Il codice di ciò che un effetto ha creato, come lo scrive il registro. */
/** Le esecuzioni della catena di `runId`: lei e le sue antenate (`parent_run_id`). */
async function chainOf(tx: Tx, runId: string): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    with recursive chain(id, parent_run_id, depth) as (
      select id, parent_run_id, 0 from ${automationRuns} where id = ${runId}
      union all
      select r.id, r.parent_run_id, c.depth + 1 from ${automationRuns} r join chain c on r.id = c.parent_run_id where c.depth < 16
    )
    select id from chain
  `);
  return [...rows].map((r) => r.id);
}

/**
 * L'esito di un'email già scritta (la chiave c'è): partita → ok col messaggio;
 * fallita → il codice del mittente, che NESSUNO ritenta da solo; in coda o in
 * invio → ancora in volo.
 */
async function emailResult(tx: Tx, objectId: string | null): Promise<EffectOutcome | EffectPending> {
  const [row] = objectId ? await tx.select().from(mailOutgoing).where(eq(mailOutgoing.id, objectId)) : [];
  if (!row) return failed("email_gone", { code: "emailGone" }, "L'invio dell'email non si trova più.");
  if (row.state === "sent") return done(row.gmailMessageId ? [row.gmailMessageId] : []);
  if (row.state === "failed") {
    const code = row.error ?? "other";
    return failed(code, { code: "emailFailed", params: { error: code } }, `L'email non è partita (${code}). Si rimanda solo con «Riprova».`);
  }
  if (row.state === "cancelled") return failed("cancelled", { code: "emailCancelled" }, "L'invio dell'email è stato annullato.");
  return { pending: true };
}

/**
 * «Manda email» (area 7, F2, S3; C-F2-1): il piano condiviso (`planEmail`: il
 * tetto sulla catena, la casella, l'indirizzo), poi NELLA STESSA transazione
 * l'invio trattenuto della Posta — senza bozza, dalla casella scelta, `send_at`
 * adesso (C-F2-2), nella conversazione della prima email allo stesso
 * indirizzo — e l'effetto con la sua chiave. Il mittente della Posta lo manda;
 * il passo aspetta l'esito (`emailResult`).
 */
async function executeEmail(eff: ActionEffect, env: EffectEnv): Promise<EffectOutcome | EffectPending> {
  const owner = env.automation.ownerId;
  if (!owner) return noOwner();
  const key = effectKey(env.runId, eff.path);
  return env.db.transaction(async (tx) => {
    const [prev] = await tx.select().from(automationEffects).where(eq(automationEffects.idempotencyKey, key));
    if (prev) return emailResult(tx, prev.objectId);
    const chain = await chainOf(tx, env.runId);
    const [sentRow] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(mailOutgoing)
      .where(and(inArray(mailOutgoing.automationRunId, chain), ne(mailOutgoing.state, "cancelled")));
    const chosen = env.mailbox?.accountId ?? null;
    const box = await automationMailboxOf(tx, owner, chosen);
    const world = {
      ...(await loadPlanWorld(tx, { ownerId: owner, projectIds: env.automation.projectId ? [env.automation.projectId] : [], personIds: [], departmentIds: [] })),
      ownerMailbox: () => (box.ok ? { ok: true as const, address: box.address } : { ok: false as const, reason: box.reason }),
    };
    const p = planEmail(world, eff, owner, sentRow?.n ?? 0, env.mailbox?.address ?? null);
    if (!p.ok) return p.outcome;
    if (!box.ok) return failed("mailbox_missing", { code: "noMailbox" }, "Nessuna casella: l'email non è partita.");
    // La stessa conversazione: la prima email di QUESTA esecuzione allo stesso indirizzo.
    const earlier = await tx
      .select({ to: mailOutgoing.toAddresses, threadId: mailOutgoing.gmailThreadId })
      .from(mailOutgoing)
      .where(and(eq(mailOutgoing.automationRunId, env.runId), eq(mailOutgoing.accountId, box.accountId), eq(mailOutgoing.state, "sent")))
      .orderBy(mailOutgoing.createdAt);
    const thread = sameConversation(
      earlier.map((e) => ({ to: e.to[0]?.email ?? "", threadId: e.threadId })),
      p.plan.to,
    );
    const domain = box.address.split("@")[1] ?? "stubwise";
    const [row] = await tx
      .insert(mailOutgoing)
      .values({
        userId: owner,
        accountId: box.accountId,
        automationRunId: env.runId,
        sendAt: sql`now()`,
        toAddresses: [{ email: p.plan.to, name: null }],
        subject: p.plan.subject,
        body: p.plan.body,
        gmailThreadId: thread?.threadId ?? null,
        rfcMessageId: `<automation-${randomUUID()}@${domain}>`,
      })
      .returning({ id: mailOutgoing.id });
    await tx.insert(automationEffects).values({ runId: env.runId, path: eff.path, round: ROUND, idempotencyKey: key, kind: "email", objectId: row!.id });
    await tx.execute(sql`select pg_notify(${MAIL_OUTGOING_CHANNEL}, ${JSON.stringify({ outgoingId: row!.id })})`);
    return { pending: true as const };
  });
}

/**
 * «Riprova» di un'email fallita (il gesto, mai il motore da solo): toglie la
 * chiave dell'invio fallito o annullato, così il passo rifatto ne scrive uno
 * nuovo. Un'email in coda, in invio o partita non si tocca.
 */
export async function releaseFailedEmail(db: Db, runId: string, path: string): Promise<void> {
  const key = effectKey(runId, path);
  await db.transaction(async (tx) => {
    const [prev] = await tx.select().from(automationEffects).where(and(eq(automationEffects.idempotencyKey, key), eq(automationEffects.kind, "email")));
    if (!prev?.objectId) return;
    const [row] = await tx.select({ state: mailOutgoing.state }).from(mailOutgoing).where(eq(mailOutgoing.id, prev.objectId));
    if (row && row.state !== "failed" && row.state !== "cancelled") return;
    await tx.delete(automationEffects).where(eq(automationEffects.id, prev.id));
  });
}

async function codesOf(tx: Tx, kind: string, objectId: string | null): Promise<string[]> {
  if (!objectId) return [];
  if (kind === "request") {
    const [r] = await tx
      .select({ number: backlogItems.number, code: projects.code })
      .from(backlogItems)
      .innerJoin(projects, eq(projects.id, backlogItems.projectId))
      .where(eq(backlogItems.id, objectId));
    return r ? [`${r.code}-R${r.number}`] : [];
  }
  if (kind === "task") {
    const rows = await tx.execute<{ code: string }>(sql`select p.code || '-' || t.number as code from tickets t join projects p on p.id = t.project_id where t.id = ${objectId}`);
    return [...rows].map((r) => r.code);
  }
  return [objectId];
}
