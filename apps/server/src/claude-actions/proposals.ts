import { chatProposalExpired, chatProposalGuard } from "../chat/claude.js";
import {
  agentSessions,
  agentSessionEvents,
  backlogItems,
  claudeActionGroups,
  claudeActions,
  claudeConversations,
  claudeProposals,
  tickets,
  type Db,
} from "@stubwise/db";
import {
  AGENT_SESSION_EVENTS_CHANNEL,
  CLAUDE_PROPOSABLE_FNS,
  CLAUDE_PROPOSAL_EXPIRY,
  type ClaudeActionFailure,
  type ClaudeActionFn,
  type ClaudeActionGroupView,
  type ClaudeClassReason,
  type ClaudeProposalOutcome,
  type ClaudeProposalView,
  type CreateClaudeProposalInput,
} from "@stubwise/shared";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import { monthlyBudgetExhausted } from "../services/agent-sessions.js";
import { readerCut, recordConversationProjects } from "../services/claude-public.js";
import type { ActionEffects } from "./effects.js";
import { classOfGroup, executeGroup, RECLASSIFIED, type ExecuteResult, type PlannedAction } from "./execute.js";
import { undoGroup, undoStateOf } from "./undo.js";

/**
 * Le PROPOSTE di Claude (chat, fetta 3). Claude propone col tool
 * `propose_action`; il ponte del worker chiama `createProposal` (la sola rotta
 * di scrittura del token del turno). Qui:
 * - una proposta nasce SEMPRE come riga, prima di qualunque scrittura;
 * - la classe si calcola sui dati veri con la prova a secco (`executeGroup`
 *   `dryRun`): chi verrebbe avvisato, se si annulla;
 * - una A si esegue SUBITO, come la persona; una B aspetta la conferma
 *   dell'autore (cookie o PAT, MAI il token del turno), che riverifica
 *   scadenza, classe e permessi;
 * - le azioni della pagina (`pageAction`) le esegue il renderer: qui si
 *   validano e basta.
 * Il registro decisioni non si tocca mai: confermare non è una decisione.
 */

type ProposalRow = typeof claudeProposals.$inferSelect;
const EVENT_SEGMENT = "stubwise-claude-actions";

/**
 * La sessione è una chiamata a @Claude nella Chat (area 4, fetta 3): lì ogni
 * proposta è di classe B (niente esecuzione immediata, niente «Annulla»), le
 * azioni della pagina non esistono e la scadenza conta i messaggi del thread.
 */
async function isChatMention(db: Db, sessionId: string): Promise<boolean> {
  const [row] = await db.select({ kind: agentSessions.kind }).from(agentSessions).where(eq(agentSessions.id, sessionId));
  return row?.kind === "chat_mention";
}
const PROPOSABLE = new Set<string>(CLAUDE_PROPOSABLE_FNS);

/** Un evento della conversazione (proposta o gruppo eseguito), con il NOTIFY dello stream. */
async function sessionEvent(
  db: Db,
  sessionId: string,
  type: "proposal" | "actions_executed",
  data: Record<string, unknown>,
): Promise<bigint> {
  const [row] = await db
    .insert(agentSessionEvents)
    .values({ sessionId, segmentId: EVENT_SEGMENT, type, data })
    .returning({ id: agentSessionEvents.id });
  await db
    .execute(sql`select pg_notify(${AGENT_SESSION_EVENTS_CHANNEL}, ${JSON.stringify({ sessionId })})`)
    .catch(() => undefined);
  return row!.id;
}

const codesOf = (r: Extract<ExecuteResult, { ok: true }>) => r.actions.flatMap((a) => a.codes);

function failureReason(f: ClaudeActionFailure): string {
  switch (f.code) {
    case "forbidden":
      return `The person can't do action ${f.index + 1}${f.permission ? ` (missing ${f.permission})` : ""}.`;
    case "not_found":
      return `Action ${f.index + 1}: not found, or not visible to the person.`;
    case "invalid":
      return `Action ${f.index + 1}: invalid (${f.message || "check the arguments"}).`;
    case "busy":
      return `Action ${f.index + 1}: the object is busy right now.`;
    case "conflict":
      return `Action ${f.index + 1}: conflict (${f.message}).`;
    case "budget_exhausted":
      return "The monthly AI budget is used up.";
    default:
      return `Action ${f.index + 1} failed.`;
  }
}

/** L'esito già dato per questa chiamata del tool (idempotenza per `toolUseId`). */
async function outcomeOf(db: Db, row: ProposalRow): Promise<ClaudeProposalOutcome> {
  if (row.status === "failed") {
    return { status: "refused", proposalId: row.id, codes: [], reason: failureReason(row.failure as ClaudeActionFailure) };
  }
  // Annullata dalla persona, o scaduta: non è più «in attesa» (review della fetta 3).
  if (row.status === "cancelled") {
    return { status: "refused", proposalId: row.id, codes: [], reason: "The person cancelled this proposal." };
  }
  if (row.status === "confirmed") {
    if (!row.groupId) return { status: "executed", proposalId: row.id, codes: [], reason: null };
    const actions = await db.select().from(claudeActions).where(eq(claudeActions.groupId, row.groupId));
    const codes = actions.flatMap((a) => (a.objects as { code?: string }[]).flatMap((o) => (o.code ? [o.code] : [])));
    return { status: "executed", proposalId: row.id, codes, reason: null };
  }
  if (await expired(db, row, new Date())) {
    return { status: "refused", proposalId: row.id, codes: [], reason: "The proposal expired." };
  }
  return { status: "awaiting_confirmation", proposalId: row.id, codes: [], reason: null };
}

/** Gli oggetti di un'azione eseguita, coi codici (per l'esito del tool e la vista del gruppo). */
async function persistCodes(db: Db, result: Extract<ExecuteResult, { ok: true }>): Promise<void> {
  for (const a of result.actions) {
    if (a.codes.length === 0) continue;
    await db
      .update(claudeActions)
      .set({ objects: a.objects.map((o, i) => ({ ...o, ...(a.codes[i] ? { code: a.codes[i] } : {}) })) })
      .where(eq(claudeActions.id, a.id));
  }
}

/**
 * Una proposta nuova di Claude, dal tool. `user` è l'AUTORE della conversazione
 * (il token del turno agisce come lui). Non lancia per un'azione sbagliata:
 * l'esito lo dice al modello.
 */
export async function createProposal(
  db: Db,
  user: SessionUser,
  sessionId: string,
  input: Required<Pick<CreateClaudeProposalInput, "toolUseId" | "actions">> & { summary?: string },
  effects: ActionEffects = {},
): Promise<ClaudeProposalOutcome> {
  const [existing] = await db
    .select()
    .from(claudeProposals)
    .where(and(eq(claudeProposals.sessionId, sessionId), eq(claudeProposals.toolUseId, input.toolUseId)));
  if (existing) return outcomeOf(db, existing);

  const actions = input.actions as PlannedAction[];
  const insert = async (
    status: ProposalRow["status"],
    declared: "A" | "B",
    extra: Partial<typeof claudeProposals.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(claudeProposals)
      .values({
        sessionId,
        requesterId: user.id,
        toolUseId: input.toolUseId,
        actions,
        summary: input.summary ?? "",
        declaredCls: declared,
        status,
        ...extra,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  };
  const refuse = async (f: ClaudeActionFailure): Promise<ClaudeProposalOutcome> => {
    const row = await insert("failed", "B", { failure: f, decidedAt: new Date() });
    return { status: "refused", proposalId: row?.id ?? null, codes: [], reason: failureReason(f) };
  };

  if (actions.some((a) => !PROPOSABLE.has(a.fn))) {
    return refuse({ code: "invalid", index: actions.findIndex((a) => !PROPOSABLE.has(a.fn)), permission: null, projectId: null, message: "not proposable" });
  }
  if (await monthlyBudgetExhausted(db)) {
    return refuse({ code: "budget_exhausted", index: 0, permission: null, projectId: null, message: "" });
  }

  const inChat = await isChatMention(db, sessionId);
  // Le azioni della pagina: le esegue il renderer (D3). Da sole, mai insieme ad
  // altre; nella Chat non ci sono (non c'è una pagina dietro una risposta).
  const page = actions.filter((a) => a.fn === "pageAction");
  if (page.length > 0 && inChat) {
    return refuse({ code: "invalid", index: actions.findIndex((a) => a.fn === "pageAction"), permission: null, projectId: null, message: "no page actions in the chat" });
  }
  if (page.length > 0) {
    if (page.length !== actions.length) {
      return refuse({ code: "invalid", index: 0, permission: null, projectId: null, message: "page actions go alone" });
    }
    // La esegue il renderer, subito: per il server è chiusa (`confirmed`, senza
    // gruppo), mai una scheda aperta da confermare (review della fetta 3).
    const row = await insert("confirmed", "A", { decidedAt: new Date(), decidedBy: user.id });
    if (!row) return outcomeOf(db, (await db.select().from(claudeProposals).where(and(eq(claudeProposals.sessionId, sessionId), eq(claudeProposals.toolUseId, input.toolUseId))))[0]!);
    const eventId = await sessionEvent(db, sessionId, "proposal", { proposalId: row.id });
    await db.update(claudeProposals).set({ eventId }).where(eq(claudeProposals.id, row.id));
    return { status: "executed", proposalId: row.id, codes: [], reason: null };
  }

  const dry = await executeGroup(db, user, { sessionId, actions, dryRun: true });
  if (!dry.ok) return refuse(dry.failure);
  // I progetti toccati da questa proposta (fetta 5, D2): per la conferma della
  // pubblicazione e per il seguito privato di una pubblica.
  await recordConversationProjects(db, sessionId, await projectsOfPlan(db, actions, dry));
  // Nella Chat tutto è proposta: la classe calcolata sale SEMPRE a B (prototipo, maintainer).
  const cls = inChat ? "B" : classOfGroup(actions, dry).cls;
  const row = await insert("open", cls);
  if (!row) {
    const [again] = await db
      .select()
      .from(claudeProposals)
      .where(and(eq(claudeProposals.sessionId, sessionId), eq(claudeProposals.toolUseId, input.toolUseId)));
    return outcomeOf(db, again!);
  }
  if (cls === "A") {
    let done: ExecuteResult;
    try {
      // La classe si riguarda DENTRO la transazione vera: se nel frattempo è
      // salita, niente resta scritto e la proposta diventa una scheda.
      done = await executeGroup(db, user, { sessionId, actions, proposalId: row.id, effects, expectClassA: true });
    } catch (error) {
      // Un errore inatteso non lascia una A aperta (review della fetta 3).
      const f: ClaudeActionFailure = { code: "other", index: 0, permission: null, projectId: null, message: "" };
      await db.update(claudeProposals).set({ status: "failed", failure: f, decidedAt: new Date() }).where(eq(claudeProposals.id, row.id));
      effects.log?.("azione di Claude fallita", error);
      return { status: "refused", proposalId: row.id, codes: [], reason: failureReason(f) };
    }
    if (!done.ok && done.failure.code === "conflict" && done.failure.message === RECLASSIFIED) {
      await db.update(claudeProposals).set({ declaredCls: "B" }).where(eq(claudeProposals.id, row.id));
      const eventId = await sessionEvent(db, sessionId, "proposal", { proposalId: row.id });
      await db.update(claudeProposals).set({ eventId }).where(eq(claudeProposals.id, row.id));
      return { status: "awaiting_confirmation", proposalId: row.id, codes: [], reason: null };
    }
    if (!done.ok) {
      await db
        .update(claudeProposals)
        .set({ status: "failed", failure: done.failure, decidedAt: new Date() })
        .where(eq(claudeProposals.id, row.id));
      return { status: "refused", proposalId: row.id, codes: [], reason: failureReason(done.failure) };
    }
    await persistCodes(db, done);
    await db
      .update(claudeProposals)
      .set({ status: "confirmed", groupId: done.groupId, decidedAt: new Date(), decidedBy: user.id })
      .where(eq(claudeProposals.id, row.id));
    await sessionEvent(db, sessionId, "actions_executed", { groupId: done.groupId, proposalId: row.id });
    return { status: "executed", proposalId: row.id, codes: codesOf(done), reason: null };
  }
  const eventId = await sessionEvent(db, sessionId, "proposal", { proposalId: row.id });
  await db.update(claudeProposals).set({ eventId }).where(eq(claudeProposals.id, row.id));
  return { status: "awaiting_confirmation", proposalId: row.id, codes: [], reason: null };
}

/** I progetti di un gruppo: `projectId` negli argomenti, e quello delle task e richieste toccate. */
async function projectsOfPlan(db: Db, actions: readonly PlannedAction[], dry: Extract<ExecuteResult, { ok: true }>): Promise<string[]> {
  const out = new Set<string>();
  for (const a of actions) if (typeof a.args["projectId"] === "string") out.add(a.args["projectId"]);
  const objects = dry.actions.flatMap((a) => a.objects);
  const taskIds = objects.filter((o) => o.kind === "task").map((o) => o.id);
  const requestIds = objects.filter((o) => o.kind === "request").map((o) => o.id);
  if (taskIds.length > 0) {
    for (const r of await db.select({ p: tickets.projectId }).from(tickets).where(inArray(tickets.id, taskIds))) out.add(r.p);
  }
  if (requestIds.length > 0) {
    for (const r of await db.select({ p: backlogItems.projectId }).from(backlogItems).where(inArray(backlogItems.id, requestIds))) {
      if (r.p) out.add(r.p);
    }
  }
  return [...out];
}

/**
 * Il confine del seguito privato per chi LEGGE (fetta 5): le proposte e i
 * gruppi da lì in poi non gli arrivano. `null` = nessun taglio.
 */
async function readerLimits(db: Db, user: SessionUser, sessionId: string): Promise<{ cut: bigint; at: Date } | null> {
  const cut = await readerCut(db, user.id, sessionId);
  if (cut === null) return null;
  const [first] = await db
    .select({ at: agentSessionEvents.createdAt })
    .from(agentSessionEvents)
    .where(and(eq(agentSessionEvents.sessionId, sessionId), gte(agentSessionEvents.id, cut)))
    .orderBy(asc(agentSessionEvents.id))
    .limit(1);
  return { cut, at: first?.at ?? new Date() };
}

/** Quanti messaggi (di chi scrive e di Claude) seguono la proposta: un input o una risposta finita. */
async function messagesAfter(db: Db, row: ProposalRow): Promise<number> {
  if (row.eventId === null) return 0;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(agentSessionEvents)
    .where(
      and(
        eq(agentSessionEvents.sessionId, row.sessionId),
        gt(agentSessionEvents.id, row.eventId),
        inArray(agentSessionEvents.type, ["input", "turn_end"]),
      ),
    );
  return r?.n ?? 0;
}

async function expired(db: Db, row: ProposalRow, now: Date): Promise<boolean> {
  if (row.status !== "open") return false;
  // Nella Chat: 20 messaggi del THREAD dopo la risposta, o 24 ore.
  if (await isChatMention(db, row.sessionId)) return chatProposalExpired(db, row, now);
  if (now.getTime() - row.createdAt.getTime() >= CLAUDE_PROPOSAL_EXPIRY.ms) return true;
  return (await messagesAfter(db, row)) >= CLAUDE_PROPOSAL_EXPIRY.messages;
}

/** La proposta come la legge chi l'ha chiesta: classe e motivi ADESSO, scadenza derivata. */
export async function proposalView(db: Db, user: SessionUser, row: ProposalRow, now = new Date()): Promise<ClaudeProposalView> {
  const isExpired = await expired(db, row, now);
  let cls: "A" | "B" | "C" = row.declaredCls;
  let reasons: ClaudeClassReason[] = [];
  const actions = row.actions as PlannedAction[];
  // La classe di adesso si ricalcola (a secco) solo per chi l'ha chiesta: un
  // lettore di una pubblica la legge e basta (fetta 5).
  const own = row.requesterId === user.id;
  if (own && row.status === "open" && !isExpired && !actions.every((a) => a.fn === "pageAction")) {
    const plan = row.undoOfGroupId ? await undoInversesOf(db, user, row.undoOfGroupId) : actions;
    const dry = plan ? await executeGroup(db, user, { sessionId: row.sessionId, actions: plan, dryRun: true }) : null;
    if (dry?.ok) ({ cls, reasons } = classOfGroup(actions, dry));
    // Nella Chat la classe resta B (i motivi restano: chi avviserebbe, se parte il lavoro).
    if (cls === "A" && (await isChatMention(db, row.sessionId))) cls = "B";
  }
  const open = row.status === "open" && !isExpired;
  return {
    id: row.id,
    sessionId: row.sessionId,
    actions: actions.map((a) => ({ fn: a.fn, args: a.args })),
    summary: row.summary,
    cls,
    reasons,
    status: isExpired ? "expired" : row.status,
    canConfirm: open && row.requesterId === user.id,
    canCancel: open && row.requesterId === user.id,
    failure: (row.failure as ClaudeActionFailure | null) ?? null,
    groupId: row.groupId,
    undoOfGroupId: row.undoOfGroupId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function undoInversesOf(db: Db, user: SessionUser, groupId: string): Promise<PlannedAction[] | null> {
  const state = await undoStateOf(db, user.id, groupId);
  return state.state === "available" ? state.inverses : null;
}

/** Le proposte di una conversazione dell'autore (la conversazione la controlla il chiamante). */
export async function listProposals(db: Db, user: SessionUser, sessionId: string): Promise<ClaudeProposalView[]> {
  const limits = await readerLimits(db, user, sessionId);
  const rows = await db
    .select()
    .from(claudeProposals)
    .where(
      and(
        eq(claudeProposals.sessionId, sessionId),
        limits ? and(isNotNull(claudeProposals.eventId), lt(claudeProposals.eventId, limits.cut)) : undefined,
      ),
    )
    .orderBy(asc(claudeProposals.createdAt));
  return Promise.all(rows.map((r) => proposalView(db, user, r)));
}

/** I gruppi eseguiti di una conversazione, con lo stato di «Annulla» per chi guarda. */
export async function listGroups(db: Db, user: SessionUser, sessionId: string): Promise<ClaudeActionGroupView[]> {
  const limits = await readerLimits(db, user, sessionId);
  const groups = await db
    .select()
    .from(claudeActionGroups)
    .where(
      and(eq(claudeActionGroups.sessionId, sessionId), limits ? lt(claudeActionGroups.executedAt, limits.at) : undefined),
    )
    .orderBy(desc(claudeActionGroups.executedAt));
  const out: ClaudeActionGroupView[] = [];
  for (const g of groups) {
    const actions = await db.select().from(claudeActions).where(eq(claudeActions.groupId, g.id)).orderBy(asc(claudeActions.seq));
    const undo = (await isChatMention(db, sessionId)) ? { state: "not_undoable" as const } : await undoStateOf(db, user.id, g.id);
    out.push({
      id: g.id,
      sessionId: g.sessionId,
      proposalId: g.proposalId,
      actions: actions.map((a) => ({
        fn: a.fn as ClaudeActionFn,
        args: a.args,
        codes: (a.objects as { code?: string }[]).flatMap((o) => (o.code ? [o.code] : [])),
      })),
      executedAt: g.executedAt.toISOString(),
      undo:
        undo.state === "available" || undo.state === "changed_after" || undo.state === "not_undoable" || undo.state === "undone" || undo.state === "not_yours"
          ? undo.state
          : "not_undoable",
      changedBy: undo.state === "changed_after" ? undo.byUserId : null,
      undoneAt: g.undoneAt?.toISOString() ?? null,
    });
  }
  return out;
}

/** La conversazione è dell'autore e non archiviata (le scritture la richiedono viva). */
export async function ownLiveConversation(db: Db, userId: string, sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ archivedAt: claudeConversations.archivedAt })
    .from(claudeConversations)
    .where(and(eq(claudeConversations.sessionId, sessionId), eq(claudeConversations.ownerId, userId)));
  return row !== undefined && row.archivedAt === null;
}

export type DecideResult =
  | { ok: true; proposal: ClaudeProposalView }
  | { ok: false; error: "not_found" | "conflict" | "expired" | "budget_exhausted" | "invalid" }
  | { ok: false; error: "refused"; proposal: ClaudeProposalView };

async function loadOwn(db: Db, user: SessionUser, proposalId: string): Promise<ProposalRow | null> {
  const [row] = await db
    .select()
    .from(claudeProposals)
    .where(and(eq(claudeProposals.id, proposalId), eq(claudeProposals.requesterId, user.id)));
  if (!row) return null;
  // Nella Chat: la risposta c'è, chi decide legge il canale, ne è membro, e il
  // canale non è archiviato (`chatProposalPlace` del prototipo). Una risposta
  // fermata archivia la sua conversazione, ma le sue schede restano decidibili.
  if (await isChatMention(db, row.sessionId)) return (await chatProposalGuard(db, user, row.sessionId)) === "ok" ? row : null;
  if (!(await ownLiveConversation(db, user.id, row.sessionId))) return null;
  return row;
}

/**
 * La CONFERMA di una scheda B (o di un «Annulla» che avviserebbe qualcuno):
 * solo l'autore; scadenza, classe e permessi riletti ADESSO. `selected`:
 * «Conferma le selezionate» (gli indici). `edited`: «Modifica» (gli argomenti
 * nuovi, rivalidati come gli altri).
 */
export async function confirmProposal(
  db: Db,
  user: SessionUser,
  proposalId: string,
  opts: { selected?: number[]; edited?: { index: number; args: Record<string, unknown> }[] } = {},
  effects: ActionEffects = {},
): Promise<DecideResult> {
  const row = await loadOwn(db, user, proposalId);
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "open") return { ok: false, error: "conflict" };
  if (await expired(db, row, new Date())) return { ok: false, error: "expired" };
  if (await monthlyBudgetExhausted(db)) return { ok: false, error: "budget_exhausted" };
  // «Conferma le selezionate»: indici unici e validi; un elenco vuoto non
  // brucia la proposta (review della fetta 3).
  const baseActions = row.actions as PlannedAction[];
  const selected =
    opts.selected === undefined
      ? baseActions.map((_, i) => i)
      : [...new Set(opts.selected)].filter((i) => i >= 0 && i < baseActions.length).sort((a, b) => a - b);
  if (!row.undoOfGroupId && selected.length === 0) return { ok: false, error: "invalid" };
  // Una sola conferma: la riga si reclama prima di eseguire.
  const claimed = await db
    .update(claudeProposals)
    .set({ status: "confirmed", decidedAt: new Date(), decidedBy: user.id })
    .where(and(eq(claudeProposals.id, row.id), eq(claudeProposals.status, "open")))
    .returning({ id: claudeProposals.id });
  if (claimed.length === 0) return { ok: false, error: "conflict" };

  let result: ExecuteResult;
  if (row.undoOfGroupId) {
    const undone = await undoGroup(db, user, row.undoOfGroupId, { confirmed: true, effects });
    result = undone.ok
      ? { ok: true, groupId: undone.kind === "undone" ? undone.groupId : row.undoOfGroupId, actions: [], notified: [] }
      : undone.error === "refused"
        ? { ok: false, failure: undone.failure }
        : { ok: false, failure: { code: "conflict", index: 0, permission: null, projectId: null, message: undone.error } };
  } else {
    const base = baseActions;
    const edited = new Map((opts.edited ?? []).map((e) => [e.index, e.args]));
    const chosen = selected.map((i) => ({ fn: base[i]!.fn, args: edited.get(i) ?? base[i]!.args }));
    result =
      chosen.length === 0
        ? { ok: false, failure: { code: "invalid", index: 0, permission: null, projectId: null, message: "nothing selected" } }
        : await executeGroup(db, user, { sessionId: row.sessionId, actions: chosen, proposalId: row.id, effects });
  }
  if (!result.ok) {
    await db
      .update(claudeProposals)
      .set({ status: "failed", failure: result.failure })
      .where(eq(claudeProposals.id, row.id));
    const [after] = await db.select().from(claudeProposals).where(eq(claudeProposals.id, row.id));
    return { ok: false, error: "refused", proposal: await proposalView(db, user, after!) };
  }
  if (result.actions.length > 0) await persistCodes(db, result);
  await db.update(claudeProposals).set({ groupId: result.groupId }).where(eq(claudeProposals.id, row.id));
  await sessionEvent(db, row.sessionId, "actions_executed", { groupId: result.groupId, proposalId: row.id });
  const [after] = await db.select().from(claudeProposals).where(eq(claudeProposals.id, row.id));
  return { ok: true, proposal: await proposalView(db, user, after!) };
}

export async function cancelProposal(db: Db, user: SessionUser, proposalId: string): Promise<DecideResult> {
  const row = await loadOwn(db, user, proposalId);
  if (!row) return { ok: false, error: "not_found" };
  const updated = await db
    .update(claudeProposals)
    .set({ status: "cancelled", decidedAt: new Date(), decidedBy: user.id })
    .where(and(eq(claudeProposals.id, row.id), eq(claudeProposals.status, "open")))
    .returning();
  if (updated.length === 0) return { ok: false, error: "conflict" };
  await sessionEvent(db, row.sessionId, "proposal", { proposalId: row.id });
  return { ok: true, proposal: await proposalView(db, user, updated[0]!) };
}

/**
 * «Annulla» dalla riga di un gruppo. Se gli inversi avviserebbero altre
 * persone, nasce la scheda da confermare (una proposta con `undo_of_group_id`).
 */
export async function requestUndo(
  db: Db,
  user: SessionUser,
  groupId: string,
  effects: ActionEffects = {},
): Promise<
  | { ok: true; kind: "undone" }
  | { ok: true; kind: "needs_confirmation"; proposal: ClaudeProposalView }
  | { ok: false; error: string; failure?: ClaudeActionFailure }
> {
  const [group] = await db.select().from(claudeActionGroups).where(eq(claudeActionGroups.id, groupId));
  if (!group || group.requesterId !== user.id || !group.sessionId) return { ok: false, error: "not_found" };
  // Nella Chat niente «Annulla»: la conferma di una B è la decisione (prototipo, maintainer).
  if (await isChatMention(db, group.sessionId)) return { ok: false, error: "not_undoable" };
  if (!(await ownLiveConversation(db, user.id, group.sessionId))) return { ok: false, error: "not_found" };
  const result = await undoGroup(db, user, groupId, { effects });
  if (!result.ok) return { ok: false, error: result.error, ...(result.error === "refused" ? { failure: result.failure } : {}) };
  if (result.kind === "undone") {
    await sessionEvent(db, group.sessionId, "actions_executed", { groupId: result.groupId, undoOf: groupId });
    return { ok: true, kind: "undone" };
  }
  const [row] = await db
    .insert(claudeProposals)
    .values({
      sessionId: group.sessionId,
      requesterId: user.id,
      actions: result.inverses,
      declaredCls: "B",
      status: "open",
      undoOfGroupId: groupId,
    })
    .returning();
  const eventId = await sessionEvent(db, group.sessionId, "proposal", { proposalId: row!.id });
  await db.update(claudeProposals).set({ eventId }).where(eq(claudeProposals.id, row!.id));
  return { ok: true, kind: "needs_confirmation", proposal: await proposalView(db, user, { ...row!, eventId }) };
}
