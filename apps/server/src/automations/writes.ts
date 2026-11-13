import {
  automationCodeSeqs,
  automationRunInputs,
  automationRuns,
  automations,
  automationVersions,
  projects,
  type Db,
} from "@stubwise/db";
import { automationMailboxOf } from "@stubwise/notifications";
import { initialState, projectOf, render, triggerFields, visitSteps, type Automation, type AutomationFlow, type AutomationMeta } from "@stubwise/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { projectPermissionsFor } from "../auth/access.js";
import {
  AutomationError,
  automationOf,
  mailboxAddresses,
  configErrorsOf,
  forbidden,
  keepHiddenProjects,
  latestVersion,
  managedAutomation,
  notFound,
  publishedVersion,
  seen,
  sees,
  versionsOf,
  type AutomationRecord,
  type Viewer,
} from "./model.js";

/**
 * LE SCRITTURE DELLE AUTOMATIONS (area 7, fetta 1; la specifica è
 * `data/automations/writes.ts` del prototipo). Ogni scrittura vuole
 * `automations.manage` nel progetto (404 se non lo si vede, 403 senza).
 *
 * - Il codice `<PRJ>-A<n>` si prende da `automation_code_seqs` con un
 *   upsert, nella transazione della creazione: due creazioni insieme non
 *   prendono lo stesso, e una bozza eliminata non libera il suo.
 * - Una bozza si salva dicendo quale `rev` si è letto (`expectedRev`): se
 *   nel frattempo un'ALTRA persona l'ha cambiata, 409 `stale` col rev
 *   attuale (niente fusione silenziosa); i salvataggi propri di fila passano.
 * - Pubblicare e accendere: zero errori di configurazione (409 `config` con
 *   gli `issues`), i permessi del nuovo proprietario in ogni progetto noto
 *   in cui il flusso crea qualcosa (409 `permission`); chi pubblica diventa il
 *   proprietario, e `active_since` dice da quando ascolta (il consumatore non
 *   recupera gli eventi di prima).
 * - Le ESECUZIONI non si toccano mai da qui: pausa e riaccensione mettono in
 *   coda gli input di controllo (`suspend`, `resume`) che applica l'esecutore.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const MAX_ACTIVE_RUNS = 100;
const OPEN = ["running", "waiting_approval", "waiting_project", "suspended"] as const;

const invalid = (code: string, message: string, extra: Record<string, unknown> = {}) => new AutomationError(409, code, message, extra);
const badInput = (code: string, message: string) => new AutomationError(400, code, message);

async function shapeOf(db: Db | Tx, viewer: Viewer, a: AutomationRecord): Promise<Automation> {
  return automationOf(a, await versionsOf(db, a.id), await seen(db, viewer), await mailboxAddresses(db, [a]));
}

const sendsEmail = (flow: AutomationFlow): boolean => {
  let found = false;
  visitSteps(flow.steps, (s) => {
    if (s.kind === "sendEmail") found = true;
  });
  return found;
};

/**
 * La casella con cui chi accende o pubblica manderà le email (area 7, F2, S2;
 * R-J15). Solo se il flusso ha un `sendEmail`: allora è quella indicata, o —
 * se chi chiama è già il proprietario — quella che c'era. Deve essere di chi
 * chiama (una casella di un altro risponde come una che non esiste, R-G5),
 * attiva e con lo scope d'invio: la regola è `automationMailboxOf`, la stessa
 * dell'esecutore. Ritorna l'id da salvare (null se il flusso non manda email).
 */
async function mailboxForPublish(db: Db | Tx, viewer: Viewer, a: AutomationRecord, flow: AutomationFlow, requested: string | undefined): Promise<string | null> {
  if (!sendsEmail(flow)) return null;
  const id = requested ?? (a.ownerId === viewer.id ? a.mailboxAccountId : null);
  if (!id) throw invalid("mailbox_required", "Choose the mailbox the emails are sent from");
  const box = await automationMailboxOf(db, viewer.id, id);
  if (box.ok) return box.accountId;
  if (box.reason === "chosen_gone") {
    if (requested) throw notFound();
    throw invalid("mailbox_required", "Choose the mailbox the emails are sent from");
  }
  if (box.reason === "no_scope") throw invalid("mailbox_scope", "The mailbox can't send email", { missingScopes: box.missingScopes ?? [] });
  throw invalid("mailbox_expired", "The mailbox is disconnected or expired");
}

const emptyFlow = (name: string): AutomationFlow => ({ trigger: { kind: "manual" }, steps: [], titleTemplate: name });

/** Il prossimo numero di automazione del progetto: un codice non torna mai. */
async function nextSeq(tx: Tx, projectId: string): Promise<number> {
  const [row] = await tx
    .insert(automationCodeSeqs)
    .values({ projectId, next: 2 })
    .onConflictDoUpdate({ target: automationCodeSeqs.projectId, set: { next: sql`${automationCodeSeqs.next} + 1` } })
    .returning({ next: automationCodeSeqs.next });
  return row!.next - 1;
}

async function insertAutomation(tx: Tx, viewer: Viewer, input: { projectId: string; name: string; description: string; flow: AutomationFlow }): Promise<AutomationRecord> {
  const [project] = await tx.select({ code: projects.code }).from(projects).where(eq(projects.id, input.projectId));
  if (!project) throw notFound();
  const seq = await nextSeq(tx, input.projectId);
  const [a] = await tx
    .insert(automations)
    .values({ code: `${project.code}-A${seq}`, seq, name: input.name, description: input.description, projectId: input.projectId, status: "draft", createdBy: viewer.id })
    .returning();
  await tx.insert(automationVersions).values({ automationId: a!.id, n: 1, flow: input.flow, savedBy: viewer.id, rev: 1 });
  return a!;
}

/** Una bozza nuova, mai accesa, senza proprietario. */
export async function createAutomation(db: Db, viewer: Viewer, input: { projectId: string; name: string; description?: string; flow?: AutomationFlow }): Promise<Automation> {
  const name = input.name.trim();
  if (!name) throw badInput("name", "A name is required");
  if (!sees(await seen(db, viewer), input.projectId)) throw notFound();
  if (!(await projectPermissionsFor(db, viewer, input.projectId))?.has("automations.manage")) throw forbidden();
  const a = await db.transaction((tx) => insertAutomation(tx, viewer, { projectId: input.projectId, name, description: input.description?.trim() ?? "", flow: input.flow ?? emptyFlow(name) }));
  return shapeOf(db, viewer, a);
}

/** «Duplica» (anche per riprendere una versione vecchia): una bozza nuova nello stesso progetto. */
export async function duplicateAutomation(db: Db, viewer: Viewer, code: string, input: { version?: number; name: string }): Promise<Automation> {
  const source = await managedAutomation(db, viewer, code);
  const versions = await versionsOf(db, source.id);
  const version = input.version === undefined ? versions.at(-1) : versions.find((v) => v.n === input.version);
  if (!version) throw badInput("version", "Unknown version");
  const name = input.name.trim();
  if (!name) throw badInput("name", "A name is required");
  const a = await db.transaction((tx) => insertAutomation(tx, viewer, { projectId: source.projectId, name, description: source.description, flow: version.flow as AutomationFlow }));
  return shapeOf(db, viewer, a);
}

/** La bozza: si sostituisce, o nasce (versione successiva) su un'automazione pubblicata. */
export async function saveDraft(db: Db, viewer: Viewer, code: string, input: { flow: AutomationFlow; expectedRev: number | null; name?: string; description?: string }): Promise<Automation> {
  const a0 = await managedAutomation(db, viewer, code);
  if (input.name !== undefined && !input.name.trim()) throw badInput("name", "A name is required");
  const visible = await seen(db, viewer);
  await db.transaction(async (tx) => {
    const [a] = await tx.select().from(automations).where(eq(automations.id, a0.id)).for("update");
    const last = (await latestVersion(tx, a!.id))!;
    const isDraft = last.publishedAt === null;
    const current = isDraft ? last.rev : null;
    if (current !== input.expectedRev && !(isDraft && last.savedBy === viewer.id)) {
      throw invalid("stale", "Someone else changed the draft", { rev: current });
    }
    const next = structuredClone(input.flow);
    keepHiddenProjects(visible, last.flow as AutomationFlow, next);
    const rev = (last.rev ?? 0) + 1;
    if (isDraft) {
      await tx.update(automationVersions).set({ flow: next, savedAt: sql`now()`, savedBy: viewer.id, rev }).where(eq(automationVersions.id, last.id));
    } else {
      await tx.insert(automationVersions).values({ automationId: a!.id, n: last.n + 1, flow: next, savedBy: viewer.id, rev });
    }
    const meta = { ...(input.name !== undefined ? { name: input.name.trim() } : {}), ...(input.description !== undefined ? { description: input.description.trim() } : {}) };
    if (Object.keys(meta).length > 0) await tx.update(automations).set(meta).where(eq(automations.id, a!.id));
  });
  const [after] = await db.select().from(automations).where(eq(automations.id, a0.id));
  return shapeOf(db, viewer, after!);
}

/** Nome e descrizione: sono dell'automazione, mai una bozza nuova. */
export async function patchAutomation(db: Db, viewer: Viewer, code: string, meta: AutomationMeta): Promise<Automation> {
  const a = await managedAutomation(db, viewer, code);
  if (meta.name !== undefined && !meta.name.trim()) throw badInput("name", "A name is required");
  const set = { ...(meta.name !== undefined ? { name: meta.name.trim() } : {}), ...(meta.description !== undefined ? { description: meta.description.trim() } : {}) };
  const [after] = Object.keys(set).length > 0 ? await db.update(automations).set(set).where(eq(automations.id, a.id)).returning() : [a];
  return shapeOf(db, viewer, after!);
}

const CREATE_PERMISSION = { createTask: "tickets.create", createMilestone: "tickets.edit", createRequest: "backlog.create" } as const;

/**
 * I controlli di chi diventa proprietario: in ogni progetto noto (quello
 * dell'automazione o uno fisso) in cui il flusso crea qualcosa deve vedere il
 * progetto e avere il permesso di crearlo (409 `permission`).
 */
async function ownerChecks(db: Db | Tx, viewer: Viewer, a: AutomationRecord, flow: AutomationFlow): Promise<void> {
  const needs: { projectId: string; permission: (typeof CREATE_PERMISSION)[keyof typeof CREATE_PERMISSION] }[] = [];
  visitSteps(flow.steps, (step) => {
    if (step.kind !== "createTask" && step.kind !== "createMilestone" && step.kind !== "createRequest") return;
    const t = projectOf(step);
    const projectId = t?.mode === "fixed" ? t.projectId : t?.mode === "own" ? a.projectId : null;
    if (projectId) needs.push({ projectId, permission: CREATE_PERMISSION[step.kind] });
  });
  const visible = await seen(db, viewer);
  for (const n of needs) {
    const perms = sees(visible, n.projectId) ? await projectPermissionsFor(db as Db, viewer, n.projectId) : null;
    if (!perms?.has(n.permission)) throw invalid("permission", `You need ${n.permission} where the automation creates it`, { permission: n.permission, projectId: n.projectId });
  }
}

async function failOnConfig(db: Db | Tx, viewer: Viewer, a: AutomationRecord, flow: AutomationFlow): Promise<void> {
  const issues = await configErrorsOf(db, a, flow, viewer.id);
  if (issues.length > 0) throw invalid("config", "The flow has configuration errors", { issues });
}

const checkRev = (rev: number | null, expectedRev: number | null | undefined) => {
  if (expectedRev !== undefined && rev !== expectedRev) throw invalid("stale", "The draft changed", { rev });
};

/** «Pubblica»: la bozza diventa la versione con cui partono le esecuzioni nuove; chi pubblica è il proprietario. */
export async function publishAutomation(db: Db, viewer: Viewer, code: string, opts: { expectedRev?: number | null; mailboxAccountId?: string }): Promise<Automation> {
  const a0 = await managedAutomation(db, viewer, code);
  // Review F1, M5: la bozza si rilegge e si valida SOTTO il lock
  // dell'automazione (lo stesso di `saveDraft`), e si pubblica quella: un
  // salvataggio concorrente o è prima (e si valida il suo flusso) o aspetta.
  await db.transaction(async (tx) => {
    const [a] = await tx.select().from(automations).where(eq(automations.id, a0.id)).for("update");
    const draft = await latestVersion(tx, a!.id);
    if (!draft || draft.publishedAt !== null) throw invalid("no_draft", "There is no draft to publish");
    checkRev(draft.rev, opts.expectedRev);
    await failOnConfig(tx, viewer, a!, draft.flow as AutomationFlow);
    await ownerChecks(tx, viewer, a!, draft.flow as AutomationFlow);
    const mailboxAccountId = await mailboxForPublish(tx, viewer, a!, draft.flow as AutomationFlow, opts.mailboxAccountId);
    await tx.update(automationVersions).set({ publishedAt: sql`now()`, publishedBy: viewer.id }).where(eq(automationVersions.id, draft.id));
    await tx
      .update(automations)
      .set({ ownerId: viewer.id, mailboxAccountId, ...(a!.status === "draft" ? { status: "active" as const, activeSince: sql`now()` } : {}) })
      .where(eq(automations.id, a!.id));
  });
  const [after] = await db.select().from(automations).where(eq(automations.id, a0.id));
  return shapeOf(db, viewer, after!);
}

/** «Accendi»: una bozza mai accesa si pubblica; una in pausa torna attiva e le sospese riprendono. */
export async function activateAutomation(db: Db, viewer: Viewer, code: string, opts: { expectedRev?: number | null; mailboxAccountId?: string }): Promise<Automation> {
  const a = await managedAutomation(db, viewer, code);
  if (a.status === "active") return shapeOf(db, viewer, a);
  if (a.status === "draft") return publishAutomation(db, viewer, code, opts);
  const live = await publishedVersion(db, a.id);
  if (!live) throw invalid("config", "Nothing is published", { issues: [] });
  await failOnConfig(db, viewer, a, live.flow as AutomationFlow);
  await ownerChecks(db, viewer, a, live.flow as AutomationFlow);
  const mailboxAccountId = await mailboxForPublish(db, viewer, a, live.flow as AutomationFlow, opts.mailboxAccountId);
  await db.transaction(async (tx) => {
    await tx
      .update(automations)
      .set({ ownerId: viewer.id, mailboxAccountId, status: "active", pausedBy: null, pausedAt: null, pausedReason: null, activeSince: sql`now()` })
      .where(eq(automations.id, a.id));
    const suspended = await tx.select({ id: automationRuns.id }).from(automationRuns).where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.status, "suspended")));
    if (suspended.length > 0) await tx.insert(automationRunInputs).values(suspended.map((r) => ({ runId: r.id, input: { control: "resume", byId: viewer.id }, byId: viewer.id })));
  });
  const [after] = await db.select().from(automations).where(eq(automations.id, a.id));
  return shapeOf(db, viewer, after!);
}

/** «Metti in pausa»: nessun inizio nuovo; le esecuzioni ferme su un'attesa si sospendono (l'esecutore). */
export async function pauseAutomation(db: Db, viewer: Viewer, code: string): Promise<Automation> {
  const a = await managedAutomation(db, viewer, code);
  if (a.status !== "active") throw invalid("not_active", "The automation is not active");
  await db.transaction(async (tx) => {
    await tx
      .update(automations)
      .set({ status: "paused", pausedBy: viewer.id, pausedAt: sql`now()`, pausedReason: "manual", activeSince: null })
      .where(eq(automations.id, a.id));
    const waiting = await tx
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(and(eq(automationRuns.automationId, a.id), inArray(automationRuns.status, ["waiting_approval", "waiting_project"])));
    if (waiting.length > 0) await tx.insert(automationRunInputs).values(waiting.map((r) => ({ runId: r.id, input: { control: "suspend", byId: viewer.id }, byId: viewer.id })));
  });
  const [after] = await db.select().from(automations).where(eq(automations.id, a.id));
  return shapeOf(db, viewer, after!);
}

/** Elimina la bozza: tutta l'automazione se mai pubblicata (il codice resta consumato), altrimenti la versione. */
export async function deleteDraft(db: Db, viewer: Viewer, code: string, opts: { expectedRev?: number | null }): Promise<void> {
  const a = await managedAutomation(db, viewer, code);
  const versions = await versionsOf(db, a.id);
  const last = versions.at(-1)!;
  if (last.publishedAt !== null) throw invalid("no_draft", "There is no draft to delete");
  if (opts.expectedRev !== undefined && last.rev !== opts.expectedRev && last.savedBy !== viewer.id) throw invalid("stale", "Someone else changed the draft", { rev: last.rev });
  if (versions.length === 1) await db.delete(automations).where(eq(automations.id, a.id));
  else await db.delete(automationVersions).where(eq(automationVersions.id, last.id));
}

/**
 * Gli errori di un flusso a schermo non ancora salvato, visti dal proprietario
 * che avrebbe: chi chiama, perché pubblicandolo lo diventa (review F1, I3).
 */
export async function checkFlow(db: Db, viewer: Viewer, code: string, flow: AutomationFlow) {
  const a = await managedAutomation(db, viewer, code);
  return { issues: await configErrorsOf(db, a, flow, viewer.id) };
}

/** Il tetto di un evento dato a mano: un testo per campo, e l'evento intero. */
const MANUAL_EVENT_TEXT_MAX = 4_000;
const MANUAL_EVENT_JSON_MAX = 16_384;

/**
 * Un evento dato a mano a «Avvia ora» (review F1, I4): solo i campi
 * dell'inizio (`triggerFields`, `<gruppo>.<campo>`), con valori semplici e un
 * tetto. Altro non entra in un'esecuzione che agisce a nome del proprietario.
 */
function checkManualEvent(flow: AutomationFlow, event: Record<string, unknown>): void {
  const allowed = new Set(triggerFields(flow, []).map((f) => f.key));
  const bad = () => badInput("event", "The start data doesn't match the start's fields");
  if (JSON.stringify(event).length > MANUAL_EVENT_JSON_MAX) throw bad();
  for (const [group, fields] of Object.entries(event)) {
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw bad();
    for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
      if (!allowed.has(`${group}.${name}`)) throw bad();
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw bad();
      if (typeof value === "string" && value.length > MANUAL_EVENT_TEXT_MAX) throw bad();
    }
  }
}

/**
 * «Avvia ora»: un'esecuzione col dato dell'inizio a mano, che l'esecutore muove
 * al prossimo giro. L'esecuzione agisce coi permessi del PROPRIETARIO: con un
 * evento a mano su un inizio che non è manuale, chi avvia passa gli stessi
 * controlli di chi pubblica (review F1, I4), o potrebbe far creare a nome
 * del proprietario dove lui non può.
 */
export async function startManualRun(db: Db, viewer: Viewer, code: string, input: { event?: Record<string, unknown> }): Promise<{ id: string; n: number }> {
  const a = await managedAutomation(db, viewer, code);
  if (a.status !== "active") throw invalid("not_active", "The automation is not active");
  const live = await publishedVersion(db, a.id);
  if (!live) throw invalid("not_active", "Nothing is published");
  const flow = live.flow as AutomationFlow;
  const event = input.event ?? (flow.trigger.kind === "manual" ? { avvio: { data: new Date().toISOString().slice(0, 10) } } : null);
  if (!event || typeof event !== "object") throw badInput("event", "The start data is required");
  if (input.event) {
    checkManualEvent(flow, input.event);
    if (flow.trigger.kind !== "manual" && a.ownerId !== viewer.id) await ownerChecks(db, viewer, a, flow);
  }
  return db.transaction(async (tx) => {
    await tx.select({ id: automations.id }).from(automations).where(eq(automations.id, a.id)).for("update");
    const [c] = await tx
      .select({
        open: sql<number>`count(*) filter (where ${inArray(automationRuns.status, [...OPEN])})::int`,
        last: sql<number>`coalesce(max(${automationRuns.n}), 0)::int`,
      })
      .from(automationRuns)
      .where(eq(automationRuns.automationId, a.id));
    if ((c?.open ?? 0) >= MAX_ACTIVE_RUNS) throw invalid("run_limit", "Too many runs in progress");
    const titled = initialState(flow, new Date().toISOString());
    titled.event = event;
    const [run] = await tx
      .insert(automationRuns)
      .values({
        automationId: a.id,
        n: (c?.last ?? 0) + 1,
        version: live.n,
        title: render(titled, flow.titleTemplate).trim() || a.name,
        status: "running",
        event,
        origin: "manual",
        startedBy: viewer.id,
        projectIds: [a.projectId],
        dueAt: sql`now()`,
      })
      .returning({ id: automationRuns.id, n: automationRuns.n });
    return run!;
  });
}

/** R-J19: la revisione provata fino in fondo. 409 `stale` se non è più quella. */
export async function markTested(db: Db, viewer: Viewer, code: string, input: { version: number; rev: number | null }): Promise<void> {
  const a = await managedAutomation(db, viewer, code);
  const [v] = await db.select().from(automationVersions).where(and(eq(automationVersions.automationId, a.id), eq(automationVersions.n, input.version)));
  if (!v) throw badInput("version", "Unknown version");
  if (v.rev !== input.rev) throw invalid("stale", "The version changed after the test", { rev: v.rev });
  await db.update(automationVersions).set({ testedRev: v.rev }).where(eq(automationVersions.id, v.id));
}
