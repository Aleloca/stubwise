import { comments, decisionRequests, departments, milestones, projectStatuses, ticketEvents, tickets, users, type Db } from "@stubwise/db";
import { sizeFromEffort, type TaskActivityEntryView } from "@stubwise/shared";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { personName } from "./people.js";
import { loadViaClaude, NOT_VIA_CLAUDE } from "./via-claude.js";

const EVENT_FIELD: Record<string, string> = {
  status_changed: "status",
  assignee_changed: "assignee",
  priority_changed: "priority",
  type_changed: "type",
  labels_changed: "labels",
  title_changed: "title",
  body_changed: "description",
  relation_added: "links",
  relation_removed: "links",
  milestone_changed: "milestone",
  // Fetta 2: i nomi dei campi del prototipo (`FIELD_LABEL`, «size» del seme).
  planned_week_changed: "week",
  department_changed: "department",
  effort_changed: "size",
};

function eventValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(", ");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Il registro di una task (`GET /api/tasks/:ticketId/activity`): commenti,
 * cambi di campo e richieste di decisione, in ordine di tempo. Estratto dalla
 * rotta (chat, fetta 3) per derivarci a lettura il segno «via Claude».
 */
export async function taskActivity(db: Db, ticketId: string): Promise<TaskActivityEntryView[]> {
  // I nomi degli stati del progetto: un cambio di stato si legge col nome.
  const statusRows = await db
    .select({ id: projectStatuses.id, name: projectStatuses.name, legacy: projectStatuses.legacyStatus })
    .from(projectStatuses)
    .innerJoin(tickets, eq(tickets.projectId, projectStatuses.projectId))
    .where(eq(tickets.id, ticketId))
    .orderBy(asc(projectStatuses.position));
  const nameById = new Map(statusRows.map((s) => [s.id, s.name]));
  const nameByLegacy = new Map<string, string>();
  for (const s of statusRows) if (!nameByLegacy.has(s.legacy)) nameByLegacy.set(s.legacy, s.name);
  /**
   * Lo stato di un `status_changed`: dall'id se l'evento lo porta (scritture
   * umane dell'app nuova) e lo stato esiste ancora; se no il primo stato del
   * progetto con quel `legacy_status`; se no il valore dell'enum.
   */
  const statusName = (id: unknown, legacy: unknown): string | null => {
    if (typeof id === "string" && nameById.has(id)) return nameById.get(id)!;
    if (typeof legacy === "string") return nameByLegacy.get(legacy) ?? legacy;
    return eventValue(legacy);
  };
  /**
   * Il valore mostrato di un evento: lo stato per nome (vedi sopra), il
   * reparto, l'assegnatario e il traguardo per nome (l'id così com'è se
   * non esistono più), la taglia XS–XL dall'effort; il resto com'è. Si
   * risolve A LETTURA, quindi vale anche per gli eventi vecchi.
   */
  const valueOf = (kind: string, payload: Record<string, unknown>, side: "from" | "to"): string | null => {
    const raw = payload[side];
    if (kind === "status_changed") return statusName(payload[side === "from" ? "fromStatusId" : "toStatusId"], raw);
    if (kind === "department_changed") return typeof raw === "string" ? (departmentName.get(raw) ?? raw) : null;
    if (kind === "assignee_changed") return typeof raw === "string" ? (userName.get(raw) ?? raw) : null;
    if (kind === "milestone_changed") return typeof raw === "string" ? (milestoneName.get(raw) ?? raw) : null;
    if (kind === "effort_changed") return typeof raw === "number" ? sizeFromEffort(raw) : null;
    return eventValue(raw);
  };
  const departmentName = new Map(
    (await db.select({ id: departments.id, name: departments.name }).from(departments)).map((d) => [d.id, d.name]),
  );
  const [commentRows, eventRows, decisionRows] = await Promise.all([
    db.select().from(comments).where(eq(comments.ticketId, ticketId)),
    db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticketId)),
    db
      .select({ id: decisionRequests.id, by: decisionRequests.askedByUserId, at: decisionRequests.createdAt })
      .from(decisionRequests)
      .where(eq(decisionRequests.ticketId, ticketId)),
  ]);
  // Persone e traguardi nominati dagli eventi: UNA query per lista, solo sugli id che compaiono.
  const idsOf = (kind: string): string[] => [
    ...new Set(
      eventRows
        .filter((e) => e.kind === kind)
        .flatMap((e) => {
          const p = (e.payload ?? {}) as Record<string, unknown>;
          return [p.from, p.to].filter((v): v is string => typeof v === "string" && z.uuid().safeParse(v).success);
        }),
    ),
  ];
  const assigneeIds = idsOf("assignee_changed");
  const milestoneIds = idsOf("milestone_changed");
  const [userRows, milestoneRows] = await Promise.all([
    assigneeIds.length
      ? db
          .select({ id: users.id, email: users.email, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, assigneeIds))
      : [],
    milestoneIds.length
      ? db
          .select({ id: milestones.id, name: milestones.name })
          .from(milestones)
          .where(inArray(milestones.id, milestoneIds))
      : [],
  ]);
  const userName = new Map(userRows.map((u) => [u.id, personName(u)]));
  // «via Claude» (chat, fetta 3): derivato dalle colonne, UNA query per registro.
  const via = await loadViaClaude(db, [
    ...commentRows.map((c) => c.viaClaudeActionId),
    ...eventRows.map((e) => e.viaClaudeActionId),
  ]);
  const milestoneName = new Map(milestoneRows.map((m) => [m.id, m.name]));
  const entries: (TaskActivityEntryView & { sortAt: number })[] = [
    ...commentRows.map((c) => ({
      id: c.id,
      taskId: ticketId,
      kind: "comment" as const,
      authorId: c.authorType === "user" ? c.authorId : null,
      at: c.createdAt.toISOString(),
      body: c.body,
      ...(c.replyToCommentId ? { replyToId: c.replyToCommentId } : {}),
      ...(c.editedAt ? { editedAt: c.editedAt.toISOString() } : {}),
      ...(c.deletedAt ? { deletedAt: c.deletedAt.toISOString() } : {}),
      ...(c.deletedByUserId ? { deletedById: c.deletedByUserId } : {}),
      ...via(c.viaClaudeActionId),
      sortAt: c.createdAt.getTime(),
    })),
    ...eventRows.map((e) => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      return {
        id: e.id,
        taskId: ticketId,
        kind: "field_change" as const,
        authorId: e.actorId,
        at: e.createdAt.toISOString(),
        field: EVENT_FIELD[e.kind] ?? e.kind,
        from: valueOf(e.kind, payload, "from"),
        to: valueOf(e.kind, payload, "to"),
        ...via(e.viaClaudeActionId),
        sortAt: e.createdAt.getTime(),
      };
    }),
    ...decisionRows.map((d) => ({
      id: d.id,
      taskId: ticketId,
      kind: "decision" as const,
      authorId: d.by,
      at: d.at.toISOString(),
      decisionRequestId: d.id,
      ...NOT_VIA_CLAUDE,
      sortAt: d.at.getTime(),
    })),
  ];
  return entries
    .sort((a, b) => a.sortAt - b.sortAt || a.id.localeCompare(b.id))
    .map((entry): TaskActivityEntryView => {
      const { sortAt, ...rest } = entry;
      void sortAt;
      return rest;
    });
}
